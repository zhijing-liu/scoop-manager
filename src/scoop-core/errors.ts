/**
 * scoop-core 内部错误模型。
 *
 * 从 src/server/errors.ts 独立出来，scoop-core 不再依赖 Hono。
 * AppError / ErrorCode / isAppError 是共享的，scoop-core 与 Web 层共同使用；
 * envelope / failure / honoErrorHandler 这些 HTTP 相关函数仍留在 server/errors.ts。
 */

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

/** 对可能含凭据的 URL / 代理串做脱敏，形如 http://user:***@host:port。 */
export function redactSecret(text: string): string {
  return text.replace(/(\w+:\/\/[^:/\s@]+):[^@\s/]+@/g, '$1:***@');
}
