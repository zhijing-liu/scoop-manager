/**
 * 任务（Job）契约。
 *
 * 这是后端、接口、前端三层的唯一共享契约，任何字段调整都必须同步更新
 * docs/API.md 与 public/js/sse.js。
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timeout';

export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'canceled', 'timeout'];

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** 任务类型：用于前端着色与文案映射 */
export type JobKind =
  | 'scoop.install'
  | 'scoop.update'
  | 'scoop.checkup'
  | 'scoop.export'
  | 'scoop.import'
  | 'app.install'
  | 'app.status'
  | 'app.uninstall'
  | 'app.update'
  | 'app.hold'
  | 'app.unhold'
  | 'app.cleanup'
  | 'app.reset'
  | 'app.list'
  | 'app.clean-remains'
  | 'bucket.add'
  | 'bucket.remove'
  | 'bucket.update'
  | 'config.set'
  | 'config.remove'
  | 'cache.remove'
  | 'script.run';

export type LogStream = 'stdout' | 'stderr' | 'system';

export interface JobError {
  code: string;
  message: string;
  detail?: unknown;
}

export interface JobEvent {
  /** 单调递增序号，用于 SSE 断线重连时按 Last-Event-ID 补偿 */
  seq: number;
  ts: number;
  type: 'log' | 'status' | 'done';
  stream?: LogStream;
  text?: string;
  status?: JobStatus;
  exitCode?: number | null;
  error?: JobError;
}

/**
 * 任务的「原始请求」快照。
 *
 * 存在的意义：`target` 只是给人看的展示字符串（逗号拼接的应用名），
 * 从它反推请求会丢掉 global / arch / force 等参数 —— 全局应用甚至会被按用户范围重放。
 * 因此创建任务时把原始请求原样存下来，前端「一键重试」直接重放它。
 */
export interface JobRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 完整 API 路径，例如 /api/apps/update（前端去掉 /api 前缀后交给 api 客户端） */
  path: string;
  /** 原始请求体，与首次请求完全一致 */
  body?: Record<string, unknown>;
}

export interface JobSummary {
  id: string;
  kind: JobKind;
  title: string;
  target: string | null;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  canCancel: boolean;
  error: JobError | null;
  /** 原始请求快照；null 表示该任务不提供一键重试 */
  request: JobRequest | null;
  /** 已产生的事件最大序号 */
  seq: number;
}

export interface JobDetail extends JobSummary {
  /** 环形缓冲中的日志（可能因超出上限而被裁剪） */
  logs: Array<{ seq: number; ts: number; stream: LogStream; text: string }>;
  /** 环形缓冲是否已发生裁剪，前端据此提示"更早日志已丢弃" */
  truncated: boolean;
}
