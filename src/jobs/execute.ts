/**
 * 任务执行桥接层。
 *
 * 把「创建任务 -> 执行命令 -> 汇总状态」这段重复逻辑收敛到一处，让路由层
 * 只关心业务语义。所有长耗时操作都必须经由这里，保证：
 *   - 每个任务都有完整的生命周期与实时日志
 *   - 错误被翻译成中文提示 + 结构化错误码
 *   - 执行结束后按需失效缓存
 */

import { AppError, isAppError } from '../server/errors.js';
import { createLogger } from '../utils/logger.js';
import { jobManager } from './manager.js';
import type { JobError, JobKind, JobRequest, JobStatus, JobSummary } from './types.js';
import { ScoopClient, createJobHook } from '../scoop-core/instance.js';
import { run, type RunOptions, type RunResult, type OutputStream } from '../scoop-core/runner.js';

const logger = createLogger('job-exec');

// 本模块是 web 层的 task-orchestration，
// runner 已经从 scoop-core 解耦了 jobs；这里是唯一需要把两者重新接起来的地方。

export interface JobContext {
  readonly jobId: string;
  /** 写入一行日志（会实时推送给前端） */
  log: (text: string, stream?: OutputStream) => void;
  /** 执行 scoop 命令，自动接入串行队列、日志与取消 */
  scoop: (args: string[], options?: Partial<RunOptions>) => Promise<RunResult>;
  /** 执行自定义 PowerShell 脚本（内部使用，调用方需自行完成转义） */
  script: (body: string, options?: Partial<RunOptions>) => Promise<RunResult>;
  /** 已经注入了本 job 取消钩子的 ScoopClient，适合用 install/update/cleanup 等高层方法 */
  client: ScoopClient;
}

export interface JobOutcome {
  status?: Extract<JobStatus, 'succeeded' | 'failed' | 'canceled' | 'timeout'>;
  exitCode?: number | null;
  error?: JobError | null;
}

export interface StartJobOptions {
  kind: JobKind;
  title: string;
  target?: string | null;
  /**
   * 原始请求快照，供前端「一键重试」原样重放。
   * 传了才会有重试入口；不传（或落盘时被判定为体积/格式不达标）则前端不显示重试按钮。
   */
  request?: JobRequest | null;
  /** 业务执行体 */
  execute: (ctx: JobContext) => Promise<JobOutcome | void>;
  /** 无论成功失败都会调用，可用于失效缓存 */
  onSettled?: (result: { status: JobStatus }) => void;
}

const DEFAULT_RUN: RunOptions = { label: 'Scoop 命令' };

function createContext(jobId: string): JobContext {
  const hook = createJobHook(jobId);
  // 给本 job 创建一个专属 ScoopClient，自动接取消钩子；路由层可用 ctx.client.install() 等高层方法
  const client = new ScoopClient({ hookRun: hook });
  return {
    jobId,
    log: (text: string, stream: OutputStream = 'system') => jobManager.log(jobId, stream, text),
    scoop: async (args: string[], options?: Partial<RunOptions>) => {
      return client.raw(args, options?.label ?? args.join(' '), {
        timeoutMs: options?.timeoutMs,
        serial: options?.serial,
        onLine: (stream: OutputStream, line: string) => jobManager.log(jobId, stream, line),
        env: options?.env,
        cwd: options?.cwd,
      });
    },
    script: async (body: string, options?: Partial<RunOptions>) => {
      // ScoopClient 没有暴露 raw-script；直接用 runner.run + 同一个 hook
      const wrapped = hook({
        ...DEFAULT_RUN,
        label: options?.label ?? '自定义脚本',
        script: body,
        timeoutMs: options?.timeoutMs,
        serial: options?.serial ?? true,
        onLine: (stream: OutputStream, line: string) => jobManager.log(jobId, stream, line),
        env: options?.env,
        cwd: options?.cwd,
      });
      return run(wrapped);
    },
    client,
  };
}

/** 把执行结果或异常翻译成任务终态。 */
export function translateResult(result: RunResult, label: string): JobOutcome {
  if (result.canceled) {
    return { status: 'canceled', exitCode: null, error: { code: 'CANCELED', message: `${label} 已被取消。` } };
  }
  if (result.timedOut) {
    return { status: 'timeout', exitCode: null, error: { code: 'TIMEOUT', message: `${label} 执行超时。` } };
  }
  if (result.code !== 0) {
    return {
      status: 'failed',
      exitCode: result.code,
      error: { code: 'COMMAND_FAILED', message: `${label} 执行失败（退出码 ${result.code}）。` },
    };
  }
  return { status: 'succeeded', exitCode: 0, error: null };
}

function translateError(error: unknown): { status: Extract<JobStatus, 'failed' | 'canceled' | 'timeout'>; error: JobError; exitCode: number | null } {
  if (isAppError(error)) {
    const appError = error as AppError;
    if (appError.code === 'CANCELED') {
      return { status: 'canceled', error: { code: appError.code, message: appError.message, detail: appError.detail }, exitCode: null };
    }
    if (appError.code === 'TIMEOUT') {
      return { status: 'timeout', error: { code: appError.code, message: appError.message, detail: appError.detail }, exitCode: null };
    }
    return { status: 'failed', error: { code: appError.code, message: appError.message, detail: appError.detail }, exitCode: 1 };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'failed', error: { code: 'INTERNAL', message: `执行过程中发生未预期的错误：${message}` }, exitCode: 1 };
}

/**
 * 创建并启动一个任务。
 * 立即返回任务摘要，真正的执行在后台进行，前端通过 SSE 观察进度。
 */
export function startJob(options: StartJobOptions): JobSummary {
  const created = jobManager.create({
    kind: options.kind,
    title: options.title,
    target: options.target ?? null,
    canCancel: true,
    request: options.request ?? null,
  });

  void (async () => {
    jobManager.start(created.id);
    const context = createContext(created.id);
    let finalStatus: JobStatus = 'failed';
    try {
      const outcome = (await options.execute(context)) ?? {};
      const status = outcome.status ?? 'succeeded';
      finalStatus = status;
      jobManager.finish(created.id, {
        status,
        exitCode: outcome.exitCode ?? 0,
        error: outcome.error ?? null,
      });
    } catch (error) {
      const translated = translateError(error);
      finalStatus = translated.status;
      jobManager.log(created.id, 'system', translated.error.message);
      jobManager.finish(created.id, { status: translated.status, exitCode: translated.exitCode, error: translated.error });
    } finally {
      try {
        options.onSettled?.({ status: finalStatus });
      } catch (error) {
        logger.warn(`任务收尾回调异常: ${(error as Error).message}`);
      }
    }
  })();

  return jobManager.get(created.id) as JobSummary;
}
