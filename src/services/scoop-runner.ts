/**
 * Scoop 命令执行器。
 *
 * 这是整个后端唯一真正"驱动外部世界"的出口之一（另一个是文件扫描）。
 *
 * 关键设计：
 *   - 绝不使用 shell:true。参数以 argv 数组交给 spawn，由 Node/Bun 负责
 *     Windows 命令行转义；PowerShell 侧再用单引号字面量二次包裹。
 *   - 变更类操作默认进入串行队列，避免 scoop 并发损坏。
 *   - 支持流式逐行回调、超时、取消（杀整棵进程树）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { jobManager } from '../jobs/manager.js';
import { mutationQueue } from '../jobs/queue.js';
import { AppError } from '../server/errors.js';
import { createLogger } from '../utils/logger.js';
import { buildRawCommand, buildScriptCommand, killProcessTree, powerShellArgs, requirePowerShell } from './powershell.js';
import { requireScoopEnvironment } from './scoop-locator.js';

const logger = createLogger('runner');

export type OutputStream = 'stdout' | 'stderr' | 'system';

export interface RunOptions {
  /** 传给 scoop.ps1 的参数（不含脚本路径本身） */
  args?: string[];
  /** 直接执行的 PowerShell 脚本体（与 args 二选一；调用方必须已做转义） */
  script?: string;
  /** 用于日志与队列展示的中文标签 */
  label: string;
  /** 是否进入串行队列（默认 true；只读命令可显式传 false） */
  serial?: boolean;
  /** 超时毫秒数，默认 30 分钟 */
  timeoutMs?: number;
  /** 关联的任务 ID，用于注册取消回调 */
  jobId?: string;
  /** 额外注入的环境变量 */
  env?: Record<string, string>;
  /** 逐行输出回调 */
  onLine?: (stream: OutputStream, line: string) => void;
  /** 覆盖工作目录 */
  cwd?: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  canceled: boolean;
  timedOut: boolean;
  durationMs: number;
}

interface Handle {
  result: Promise<RunResult>;
  cancel: () => void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 行切分器。
 *
 * scoop 的输出混用了 \n、\r\n 以及下载进度用的裸 \r。这里把三种都当作分隔符，
 * 同时丢弃与上一行完全相同的重复行（进度条会疯狂刷新同一内容）。
 */
function createLineSplitter(onLine: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buffer = '';
  let lastLine = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.search(/[\r\n]/);
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
        const separatorLength = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(index + separatorLength);
        if (line.length > 0 && line !== lastLine) {
          lastLine = line;
          onLine(line);
        }
        index = buffer.search(/[\r\n]/);
      }
      // 防御：某些工具会输出超长无换行内容
      if (buffer.length > 64 * 1024) {
        const overflow = buffer.slice(0, buffer.length - 1024).replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
        if (overflow) onLine(overflow);
        buffer = buffer.slice(-1024);
      }
    },
    flush(): void {
      const line = buffer.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
      buffer = '';
      if (line.length > 0 && line !== lastLine) {
        lastLine = line;
        onLine(line);
      }
    },
  };
}

/** 启动一个 PowerShell 子进程并接管其输出。 */
function startProcess(script: string, options: RunOptions, env: Record<string, string>): Handle {
  const ps = requirePowerShell();
  const start = Date.now();
  let canceled = false;
  let timedOut = false;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(ps.path, powerShellArgs(script), {
      windowsHide: true,
      cwd: options.cwd,
      env: { ...process.env, ...env },
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    throw new AppError('COMMAND_FAILED', `无法启动 PowerShell: ${(error as Error).message}`);
  }

  let stdout = '';
  let stderr = '';

  const splitter = createLineSplitter((line) => {
    options.onLine?.('stdout', line);
  });
  const errSplitter = createLineSplitter((line) => {
    options.onLine?.('stderr', line);
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    splitter.push(chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    errSplitter.push(chunk);
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    options.onLine?.('system', `执行超过 ${Math.round(timeoutMs / 1000)} 秒，正在终止…`);
    killProcessTree(child.pid);
  }, timeoutMs);
  timer.unref?.();

  const result = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      splitter.flush();
      errSplitter.flush();
      resolve({
        code,
        stdout,
        stderr,
        canceled,
        timedOut,
        durationMs: Date.now() - start,
      });
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      splitter.flush();
      errSplitter.flush();
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), canceled, timedOut, durationMs: Date.now() - start });
    });

    child.on('close', (code) => finish(code));
  });

  // 防止子进程等待标准输入而挂死（-NonInteractive 已覆盖大部分场景，这里是双保险）
  try {
    child.stdin.end();
  } catch {
    // ignore
  }

  return {
    result,
    cancel: () => {
      canceled = true;
      killProcessTree(child.pid);
    },
  };
}

/** 执行一次 scoop 调用（或自定义脚本）。 */
export async function run(options: RunOptions): Promise<RunResult> {
  const execute = async (): Promise<RunResult> => {
    // 排队期间被取消：直接短路，不产生任何副作用
    if (options.jobId && jobManager.isCancelRequested(options.jobId)) {
      options.onLine?.('system', '任务在排队期间已被取消。');
      return { code: null, stdout: '', stderr: '', canceled: true, timedOut: false, durationMs: 0 };
    }

    const env: Record<string, string> = { ...(options.env ?? {}) };
    let script: string;

    if (options.script) {
      script = buildRawCommand(options.script);
    } else {
      const scoopEnv = await requireScoopEnvironment();
      // 显式注入 SCOOP，保证用户自定义路径时 scoop 不会跑去用默认目录
      env['SCOOP'] = scoopEnv.root;
      if (scoopEnv.globalRoot) env['SCOOP_GLOBAL'] = scoopEnv.globalRoot;
      script = buildScriptCommand(scoopEnv.scriptPath, options.args ?? []);
    }

    logger.debug(`执行: ${options.label}`);
    const handle = startProcess(script, options, env);
    if (options.jobId) {
      jobManager.setCancelHandler(options.jobId, handle.cancel);
    }
    try {
      return await handle.result;
    } finally {
      if (options.jobId) jobManager.setCancelHandler(options.jobId, null);
    }
  };

  if (options.serial === false) return execute();
  return mutationQueue.run(options.label, execute);
}

/** 便捷包装：执行后校验退出码，失败时抛出带 stderr 摘要的错误。 */
export async function runOrThrow(options: RunOptions): Promise<RunResult> {
  const result = await run(options);
  if (result.canceled) {
    throw new AppError('CANCELED', '任务已被取消。');
  }
  if (result.timedOut) {
    throw new AppError('TIMEOUT', `命令执行超时（${options.label}）。`);
  }
  if (result.code !== 0) {
    const summary = summarizeFailure(result.stderr || result.stdout);
    throw new AppError('COMMAND_FAILED', `${options.label} 执行失败${summary ? `：${summary}` : '。'}`, {
      detail: { exitCode: result.code, stderr: result.stderr.slice(-2000), stdout: result.stdout.slice(-2000) },
    });
  }
  return result;
}

/** 从 stderr 中提取最适合展示给用户的一行。 */
export function summarizeFailure(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // 过滤掉 PowerShell 的装饰性错误块
    .filter((line) => !/^(\+|CategoryInfo|FullyQualifiedErrorId|At line:)/i.test(line))
    .filter((line) => !/^\s*\+/.test(line));
  const preferred = lines.find((line) => /^ERROR|^WARN|^error:|^fatal:/i.test(line));
  return (preferred ?? lines[lines.length - 1] ?? '').replace(/\s+/g, ' ').slice(0, 300);
}
