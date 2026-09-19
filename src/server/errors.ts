/**
 * 统一错误模型与响应封装。
 *
 * 前端契约（全部接口一致）：
 *   成功: { ok: true,  data: T }
 *   失败: { ok: false, error: { code, message, detail? } }
 *
 * message 一律为可读的中文，前端可以直接展示；detail 用于附加结构化信息
 * （例如原始 stderr），前端按需折叠显示。
 */

import type { Context } from 'hono';

export type ErrorCode =
  | 'PLATFORM_UNSUPPORTED'
  | 'SCOOP_NOT_FOUND'
  | 'SCOOP_NOT_INSTALLED'
  | 'POWERSHELL_NOT_FOUND'
  | 'INVALID_PARAM'
  | 'NOT_FOUND'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_CANCELABLE'
  | 'COMMAND_FAILED'
  | 'TIMEOUT'
  | 'CANCELED'
  | 'INTERNAL';

export interface AppErrorOptions {
  status?: number;
  detail?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.detail = options.detail ?? null;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'INVALID_PARAM':
    case 'JOB_NOT_CANCELABLE':
      return 400;
    case 'NOT_FOUND':
    case 'JOB_NOT_FOUND':
    case 'SCOOP_NOT_FOUND':
      return 404;
    case 'PLATFORM_UNSUPPORTED':
    case 'SCOOP_NOT_INSTALLED':
    case 'POWERSHELL_NOT_FOUND':
      return 409;
    case 'COMMAND_FAILED':
    case 'TIMEOUT':
    case 'CANCELED':
      return 422;
    default:
      return 500;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; detail: unknown };
}

export function failure(error: unknown): ApiFailure {
  if (isAppError(error)) {
    return { ok: false, error: { code: error.code, message: error.message, detail: error.detail } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'INTERNAL', message: '服务内部错误', detail: message } };
}

export function statusOf(error: unknown): number {
  return isAppError(error) ? error.status : 500;
}

/** 便捷抛错器，路由层用来自解释地表达参数问题。 */
export function invalid(message: string, detail?: unknown): never {
  throw new AppError('INVALID_PARAM', message, { detail: detail ?? null });
}

export function notFound(message: string): never {
  throw new AppError('NOT_FOUND', message);
}

export function requirePlatformWindows(): void {
  if (process.platform !== 'win32') {
    throw new AppError(
      'PLATFORM_UNSUPPORTED',
      `Scoop 仅支持 Windows，当前运行平台为 ${process.platform}，所有 Scoop 相关功能不可用。`,
      { detail: { platform: process.platform } },
    );
  }
}

/** 统一成功响应体。 */
export function envelope<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

/** Hono onError 处理器。 */
export function honoErrorHandler(error: Error, c: Context): Response {
  const body = failure(error);
  const status = statusOf(error);
  if (!isAppError(error)) {
    // 非预期异常必须留下堆栈，便于排障
    console.error('[unhandled]', error);
  }
  return c.json(body, status as 400);
}
