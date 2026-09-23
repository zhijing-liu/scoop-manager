/**
 * Scoop 命令执行器。
 *
 * 这是 scoop-core 唯一真正"驱动外部世界"的出口（另一个是文件扫描）。
 *
 * 关键设计：
 *   - 绝不使用 shell:true。参数以 argv 数组交给 spawn，由 Node/Bun 负责
 *     Windows 命令行转义；PowerShell 侧再用单引号字面量二次包裹。
 *   - 变更类操作默认进入串行队列，避免 scoop 并发损坏。
 *   - 支持流式逐行回调、超时、取消（杀整棵进程树）。
 *   - 与 jobs 子系统解耦：run() 只接受 cancelRequested / cancelHandler 回调，
 *     队列则在本模块内部提供默认实现，调用方也可传入自己的 queue.run。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AppError } from './errors.js';
import { createLogger } from './logger.js';
import { buildRawCommand, buildScriptCommand, killProcessTree, powerShellArgs, requirePowerShell } from './powershell.js';
import { requireScoopEnvironment } from './locator.js';
import { SerialQueue, mutationQueue } from './queue.js';

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
  /** 额外注入的环境变量 */
  env?: Record<string, string>;
  /** 逐行输出回调 */
  onLine?: (stream: OutputStream, line: string) => void;
  /** 覆盖工作目录 */
  cwd?: string;
  /** 可选：外部提供的串行队列（默认使用全局 mutationQueue） */
  queue?: Pick<SerialQueue, 'run'>;
  /**
   * 可选：外部注入的「取消探测」函数。
   * 在排队期间和进程启动前都会被轮询；返回 true 表示调用方已请求取消，
   * runner 会短路并在不产生副作用的前提下立即返回 canceled。
   */
  cancelRequested?: () => boolean;
  /**
   * 可选：外部注入的「注册取消处理器」函数。
   * runner 会在拿到真实进程句柄后调用它，让调用方可以把 cancel 函数挂到自己的
   * 任务系统上；进程结束时再以 null 清理。
   */
  setCancelHandler?: (handler: (() => void) | null) => void;
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
    if (options.cancelRequested?.()) {
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

    // 上面这段是 execute() 里唯一的挂起点。取消请求若正好落在这里，
    // jobManager 会因为 setCancelHandler 还没注册而把任务直接判成 canceled，
    // 但进程随后照样起来跑到结束 —— 界面显示"已取消"，磁盘却真的被改了。
    // 下面到 setCancelHandler 之间没有任何 await（JS 单线程不会在这里被切入），
    // 所以补这一次检查就足以关掉整个窗口。
    if (options.cancelRequested?.()) {
      options.onLine?.('system', '任务在启动前已被取消。');
      return { code: null, stdout: '', stderr: '', canceled: true, timedOut: false, durationMs: 0 };
    }

    logger.debug(`执行: ${options.label}`);
    const handle = startProcess(script, options, env);
    if (options.setCancelHandler) {
      options.setCancelHandler(handle.cancel);
    }
    try {
      return await handle.result;
    } finally {
      if (options.setCancelHandler) options.setCancelHandler(null);
    }
  };

  if (options.serial === false) return execute();
  const queue = options.queue ?? mutationQueue;
  return queue.run(options.label, execute);
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
