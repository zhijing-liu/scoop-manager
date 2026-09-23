/**
 * 任务管理器。
 *
 * 职责：
 *   - 维护任务状态机（queued -> running -> succeeded | failed | canceled | timeout）
 *   - 每个任务一份环形日志缓冲（默认保留最近 2000 条），供 SSE 与新订阅者重放
 *   - 订阅 / 广播：SSE 连接建立时先重放历史事件，再实时接收增量
 *   - 历史持久化：只落盘摘要 + 日志尾部，避免 jobs.json 无限膨胀
 *
 * 刻意不落盘全量日志：安装过程动辄上万行，全量持久化会把磁盘写满且没有价值。
 */

import { randomUUID } from 'node:crypto';
import { JOBS_FILE, ensureDataDir } from '../config.js';
import { readJson, writeJson } from '../utils/fsx.js';
import { createLogger } from '../utils/logger.js';
import { AppError } from '../server/errors.js';
import { isTerminalStatus, type JobDetail, type JobError, type JobEvent, type JobKind, type JobRequest, type JobStatus, type JobSummary, type LogStream } from './types.js';

const logger = createLogger('jobs');

/** 单任务保留的最大事件数（含日志与状态事件） */
const MAX_EVENTS_PER_JOB = 2000;
/** 历史任务上限 */
const MAX_HISTORY = 200;
/** 持久化时每个任务保留的日志行数 */
const PERSIST_LOG_TAIL = 200;
/** 运行中任务的快照落盘间隔：崩溃恢复时最多丢失这段时间的日志 */
const ACTIVE_CHECKPOINT_MS = 10_000;

interface InternalJob {
  summary: JobSummary;
  events: JobEvent[];
  /** 被环形缓冲裁掉的事件上界（events[0].seq - 1） */
  trimmedBelow: number;
  /** 被环形缓冲裁掉的日志条数（只统计 log 事件，供 detail().truncated 精确判断） */
  trimmedLogs: number;
  listeners: Set<(event: JobEvent) => void>;
  cancelHandler: (() => void) | null;
  cancelRequested: boolean;
}

export interface CreateJobInput {
  kind: JobKind;
  title: string;
  target?: string | null;
  canCancel?: boolean;
  /** 原始请求快照：只有需要提供「一键重试」的任务才传 */
  request?: JobRequest | null;
}

/**
 * 请求快照的体积上限。
 *
 * 快照会被写进 jobs.json（并且每次运行中任务落盘都会重写一遍），
 * 所以体积极大的请求（例如带整份 Scoopfile 的导入）不留重试入口，
 * 免得几 MB 的 body 被反复写盘。
 */
const MAX_REQUEST_BYTES = 16 * 1024;

/**
 * 落盘前收敛请求快照。
 *
 * jobs.json 在用户目录里、且 hydrate 会把它原样恢复，因此这里把它当不可信输入：
 * 只接受形如 `/api/...` 的路径（拒绝 `..`），体积或可序列化性不达标的直接丢弃 ——
 * 丢弃的后果只是"没有重试按钮"，不影响任务本身。
 */
function sanitizeRequest(request?: JobRequest | null): JobRequest | null {
  if (!request || typeof request.path !== 'string') return null;
  if (!request.path.startsWith('/api/') || request.path.includes('..')) return null;

  const method = String(request.method ?? 'POST').toUpperCase() as JobRequest['method'];
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return null;

  const body = request.body;
  if (body === undefined) return { method, path: request.path };
  try {
    if (JSON.stringify(body).length > MAX_REQUEST_BYTES) return null;
  } catch {
    // 含循环引用等不可序列化的值：存不下来就不留重试入口
    return null;
  }
  return { method, path: request.path, body };
}

export interface FinishJobInput {
  status: Extract<JobStatus, 'succeeded' | 'failed' | 'canceled' | 'timeout'>;
  exitCode?: number | null;
  error?: JobError | null;
}

class JobManager {
  private readonly jobs = new Map<string, InternalJob>();
  private unsubscribeAll = new Set<() => void>();
  private persistTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.hydrate();
    // hydrate 会把崩溃前残留的 running/queued 任务改判为 failed，立刻回写一次：
    // 否则在本次运行期间没有新任务时，磁盘上的旧状态会一直停留在 running。
    this.persist();
    // 周期性给运行中任务落盘快照。否则任务执行期间崩溃时，jobs.json 里
    // 根本没有它的记录（persist 只在终态时触发），hydrate 的崩溃恢复逻辑
    // （标记 INTERRUPTED）就永远不会生效。
    this.checkpointTimer = setInterval(() => {
      if (this.hasActiveJobs()) this.persist();
    }, ACTIVE_CHECKPOINT_MS);
    this.checkpointTimer.unref?.();
  }

  // ---------------------------------------------------------------- 创建与推进

  create(input: CreateJobInput): JobSummary {
    const now = Date.now();
    const summary: JobSummary = {
      id: randomUUID(),
      kind: input.kind,
      title: input.title,
      target: input.target ?? null,
      status: 'queued',
      createdAt: now,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      canCancel: input.canCancel !== false,
      error: null,
      request: sanitizeRequest(input.request),
      seq: 0,
    };
    const internal: InternalJob = {
      summary,
      events: [],
      trimmedBelow: 0,
      trimmedLogs: 0,
      listeners: new Set(),
      cancelHandler: null,
      cancelRequested: false,
    };
    this.jobs.set(summary.id, internal);
    this.emit(internal, { type: 'status', status: 'queued' });
    this.trimHistory();
    // 排队期间崩溃也要能恢复：先落一次盘（调度去抖，与 start 的落盘合并）
    this.schedulePersist();
    return { ...summary };
  }

  start(jobId: string): void {
    const job = this.require(jobId);
    job.summary.status = 'running';
    job.summary.startedAt = Date.now();
    this.emit(job, { type: 'status', status: 'running' });
    this.schedulePersist();
  }

  log(jobId: string, stream: LogStream, text: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line.length === 0) continue;
      this.emit(job, { type: 'log', stream, text: line });
    }
  }

  /** 一次性写入多行（用于非流式的整段输出）。 */
  logBlock(jobId: string, stream: LogStream, text: string): void {
    this.log(jobId, stream, text);
  }

  finish(jobId: string, input: FinishJobInput): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (isTerminalStatus(job.summary.status)) return;
    job.summary.status = input.status;
    job.summary.endedAt = Date.now();
    job.summary.exitCode = input.exitCode ?? null;
    job.summary.error = input.error ?? null;
    job.summary.canCancel = false;
    job.cancelHandler = null;
    this.emit(job, {
      type: 'done',
      status: input.status,
      exitCode: input.exitCode ?? null,
      error: input.error ?? undefined,
    });
    this.schedulePersist();
  }

  /** 注册取消回调；任务真正开始执行后才会有可取消的进程句柄。 */
  setCancelHandler(jobId: string, handler: (() => void) | null): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.cancelHandler = handler;
  }

  /**
   * 请求取消任务。
   * 若任务尚在排队（没有进程句柄），标记 cancelRequested，等真正执行时立刻放弃。
   */
  cancel(jobId: string): { ok: true; state: 'canceled' | 'requested' } {
    const job = this.jobs.get(jobId);
    if (!job) throw new AppError('JOB_NOT_FOUND', '任务不存在或已被清理。', { status: 404 });
    if (isTerminalStatus(job.summary.status)) {
      throw new AppError('JOB_NOT_CANCELABLE', '任务已经结束，无法取消。');
    }
    if (job.cancelRequested) return { ok: true, state: 'requested' };

    job.cancelRequested = true;
    this.emit(job, { type: 'log', stream: 'system', text: '收到取消请求，正在终止进程…' });

    if (job.cancelHandler) {
      try {
        job.cancelHandler();
      } catch (error) {
        logger.warn(`取消回调执行失败: ${(error as Error).message}`);
      }
      return { ok: true, state: 'requested' };
    }

    // 尚未启动：直接判为已取消
    this.finish(jobId, { status: 'canceled', exitCode: null, error: { code: 'CANCELED', message: '任务在排队阶段被取消。' } });
    return { ok: true, state: 'canceled' };
  }

  isCancelRequested(jobId: string): boolean {
    return this.jobs.get(jobId)?.cancelRequested ?? false;
  }

  // ---------------------------------------------------------------- 查询

  get(jobId: string): JobSummary | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job.summary } : null;
  }

  require(jobId: string): InternalJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new AppError('JOB_NOT_FOUND', '任务不存在或已被清理。', { status: 404 });
    return job;
  }

  detail(jobId: string): JobDetail {
    const job = this.require(jobId);
    return {
      ...job.summary,
      logs: job.events
        .filter((event) => event.type === 'log')
        .map((event) => ({ seq: event.seq, ts: event.ts, stream: event.stream ?? 'stdout', text: event.text ?? '' })),
      // 只看日志裁剪：只被裁掉 status 事件时不应误报"更早日志已丢弃"
      truncated: job.trimmedLogs > 0,
    };
  }

  list(options: { status?: JobStatus; kind?: JobKind; limit?: number } = {}): JobSummary[] {
    const limit = options.limit ?? 100;
    return Array.from(this.jobs.values())
      .map((job) => job.summary)
      .filter((job) => (options.status ? job.status === options.status : true))
      .filter((job) => (options.kind ? job.kind === options.kind : true))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  runningCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.summary.status === 'running' || job.summary.status === 'queued') count += 1;
    }
    return count;
  }

  isTerminal(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    return job ? isTerminalStatus(job.summary.status) : true;
  }

  /** 取指定序号之后的事件，用于 SSE 断线重连补偿。 */
  eventsSince(jobId: string, sinceSeq: number): { events: JobEvent[]; truncated: boolean } {
    const job = this.require(jobId);
    const events = job.events.filter((event) => event.seq > sinceSeq);
    return { events, truncated: sinceSeq < job.trimmedBelow };
  }

  /** 订阅增量事件，返回取消订阅函数。 */
  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    const job = this.require(jobId);
    job.listeners.add(listener);
    return () => {
      job.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------- 清理

  remove(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (!isTerminalStatus(job.summary.status)) {
      throw new AppError('JOB_NOT_CANCELABLE', '运行中的任务不能删除，请先取消。');
    }
    this.jobs.delete(jobId);
    this.schedulePersist();
  }

  clearFinished(): number {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (isTerminalStatus(job.summary.status)) {
        this.jobs.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.schedulePersist();
    return removed;
  }

  // ---------------------------------------------------------------- 内部

  private emit(job: InternalJob, partial: Omit<JobEvent, 'seq' | 'ts'>): void {
    const event: JobEvent = { seq: job.summary.seq + 1, ts: Date.now(), ...partial };
    job.summary.seq = event.seq;
    job.events.push(event);
    if (job.events.length > MAX_EVENTS_PER_JOB) {
      const overflow = job.events.length - MAX_EVENTS_PER_JOB;
      for (let i = 0; i < overflow; i += 1) {
        if (job.events[i]?.type === 'log') job.trimmedLogs += 1;
      }
      job.events.splice(0, overflow);
      job.trimmedBelow = job.events[0] ? job.events[0].seq - 1 : job.trimmedBelow;
    }
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn(`SSE 订阅回调异常: ${(error as Error).message}`);
      }
    }
  }

  private trimHistory(): void {
    const terminal = Array.from(this.jobs.values())
      .filter((job) => isTerminalStatus(job.summary.status))
      .sort((a, b) => b.summary.createdAt - a.summary.createdAt);
    if (terminal.length <= MAX_HISTORY) return;
    for (const job of terminal.slice(MAX_HISTORY)) {
      this.jobs.delete(job.summary.id);
    }
  }

  /** 合并短时间内的多次写入，避免高频落盘。 */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 500);
    this.persistTimer.unref?.();
  }

  private hasActiveJobs(): boolean {
    for (const job of this.jobs.values()) {
      if (!isTerminalStatus(job.summary.status)) return true;
    }
    return false;
  }

  private persist(): void {
    try {
      ensureDataDir();
      const all = Array.from(this.jobs.values());
      // 活动任务必须全部落盘：崩溃后 hydrate 要靠这些快照把任务标记为 INTERRUPTED。
      // 终态任务只保留最近 MAX_HISTORY 条。
      const active = all
        .filter((job) => !isTerminalStatus(job.summary.status))
        .sort((a, b) => b.summary.createdAt - a.summary.createdAt);
      const terminal = all
        .filter((job) => isTerminalStatus(job.summary.status))
        .sort((a, b) => b.summary.createdAt - a.summary.createdAt)
        .slice(0, MAX_HISTORY);

      const payload = [...active, ...terminal].map((job) => ({
        summary: job.summary,
        trimmedLogs: job.trimmedLogs,
        logs: job.events
          .filter((event) => event.type === 'log')
          .slice(-PERSIST_LOG_TAIL)
          .map((event) => ({ stream: event.stream ?? 'stdout', text: event.text ?? '' })),
      }));
      writeJson(JOBS_FILE, { version: 1, jobs: payload });
    } catch (error) {
      logger.warn(`任务历史持久化失败: ${(error as Error).message}`);
    }
  }

  private hydrate(): void {
    const raw = readJson<{
      jobs?: Array<{
        summary: JobSummary;
        trimmedLogs?: number;
        logs?: Array<{ stream: LogStream; text: string }>;
      }>;
    }>(JOBS_FILE);
    if (!raw?.jobs || !Array.isArray(raw.jobs)) return;
    for (const entry of raw.jobs) {
      const summary = entry.summary;
      if (!summary?.id) continue;
      // 服务重启时仍在运行的任务必然已经中断，标记为失败而不是永远挂着
      if (!isTerminalStatus(summary.status)) {
        summary.status = 'failed';
        summary.endedAt = summary.endedAt ?? Date.now();
        summary.error = { code: 'INTERRUPTED', message: '服务重启导致任务中断。' };
        summary.canCancel = false;
      }
      const internal: InternalJob = {
        summary: { ...summary, seq: 0, canCancel: false },
        events: [],
        trimmedBelow: 0,
        // 崩溃前已被环形缓冲裁掉的日志数要延续，否则前端的"日志已截断"提示会丢失
        trimmedLogs: Number.isFinite(entry.trimmedLogs) ? Number(entry.trimmedLogs) : 0,
        listeners: new Set(),
        cancelHandler: null,
        cancelRequested: false,
      };
      internal.events = (entry.logs ?? []).map((logEntry) => ({
        seq: 0,
        ts: summary.createdAt,
        type: 'log' as const,
        stream: logEntry.stream,
        text: logEntry.text,
      }));
      // 重新编号，恢复单调性
      internal.events.forEach((event, index) => {
        event.seq = index + 1;
      });
      internal.summary.seq = internal.events.length;
      this.jobs.set(summary.id, internal);
    }
    logger.info(`已恢复 ${raw.jobs.length} 条历史任务记录`);
  }

  /** 服务关闭时同步落盘，避免最后一次状态丢失。 */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    this.persist();
  }
}

export const jobManager = new JobManager();
export type { InternalJob };
