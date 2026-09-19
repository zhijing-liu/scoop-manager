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
import { isTerminalStatus, type JobDetail, type JobError, type JobEvent, type JobKind, type JobStatus, type JobSummary, type LogStream } from './types.js';

const logger = createLogger('jobs');

/** 单任务保留的最大事件数（含日志与状态事件） */
const MAX_EVENTS_PER_JOB = 2000;
/** 历史任务上限 */
const MAX_HISTORY = 200;
/** 持久化时每个任务保留的日志行数 */
const PERSIST_LOG_TAIL = 200;

interface InternalJob {
  summary: JobSummary;
  events: JobEvent[];
  /** 被环形缓冲裁掉的事件上界（events[0].seq - 1） */
  trimmedBelow: number;
  listeners: Set<(event: JobEvent) => void>;
  cancelHandler: (() => void) | null;
  cancelRequested: boolean;
}

export interface CreateJobInput {
  kind: JobKind;
  title: string;
  target?: string | null;
  canCancel?: boolean;
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

  constructor() {
    this.hydrate();
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
      seq: 0,
    };
    const internal: InternalJob = {
      summary,
      events: [],
      trimmedBelow: 0,
      listeners: new Set(),
      cancelHandler: null,
      cancelRequested: false,
    };
    this.jobs.set(summary.id, internal);
    this.emit(internal, { type: 'status', status: 'queued' });
    this.trimHistory();
    return { ...summary };
  }

  start(jobId: string): void {
    const job = this.require(jobId);
    job.summary.status = 'running';
    job.summary.startedAt = Date.now();
    this.emit(job, { type: 'status', status: 'running' });
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
      truncated: job.trimmedBelow > 0,
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

  private persist(): void {
    try {
      ensureDataDir();
      const payload = Array.from(this.jobs.values())
        .filter((job) => isTerminalStatus(job.summary.status))
        .sort((a, b) => b.summary.createdAt - a.summary.createdAt)
        .slice(0, MAX_HISTORY)
        .map((job) => ({
          summary: job.summary,
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
    const raw = readJson<{ jobs?: Array<{ summary: JobSummary; logs?: Array<{ stream: LogStream; text: string }> }> }>(JOBS_FILE);
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
    this.persist();
  }
}

export const jobManager = new JobManager();
export type { InternalJob };
