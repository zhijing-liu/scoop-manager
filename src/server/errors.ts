/**
 * 统一错误模型与响应封装。
 *
 * 前端契约（全部接口一致）：
 *   成功: { ok: true,  data: T }
 *   失败: { ok: false, error: { code, message, detail? } }
 *
 * message 一律为可读的中文，前端可以直接展示；detail 用于附加结构化信息
 * （例如原始 stderr），前端按需折叠显示。
 *
 * AppError / ErrorCode / isAppError 的**唯一定义**已经搬到 scoop-core/errors.ts
 * （scoop-core 里的 runner / locator / installer 都用它抛错），这里只做再导出，
 * 这样无论哪层 `instanceof AppError` 都命中同一个类；本文件只新增 HTTP 相关封装。
 */

import type { Context } from 'hono';
export { AppError, isAppError, redactSecret, type ErrorCode, type AppErrorOptions } from '../scoop-core/errors.js';

import { AppError, isAppError } from '../scoop-core/errors.js';

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
