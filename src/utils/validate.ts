/**
 * 输入校验器。
 *
 * 这里是抵御命令注入的第一道（也是最重要的一道）防线：
 * 所有会进入命令行参数的用户输入，都必须先经过本模块的白名单校验，
 * 校验失败一律抛 INVALID_PARAM，绝不"尽力而为地清洗"。
 */

import { isAbsolute } from 'node:path';
import { AppError } from '../server/errors.js';

/**
 * Scoop 应用名 / Bucket 名的合法字符集。
 * 参考 Scoop 自身对 manifest 文件名的约束：字母数字开头，可含 . _ + -
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** config 的键名：字母开头，可含 . _ - */
const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** 允许透传给 scoop 的开关（白名单，只放行本工具真正会用的参数） */
const ALLOWED_FLAGS = new Set([
  '-g', // --global 全局安装
  '--global',
  '-i', // --independent 独立安装
  '--independent',
  '-n', // --no-cache 不使用缓存
  '--no-cache',
  '-u', // --no-update-scoop 不自动更新 scoop
  '--no-update-scoop',
  '-s', // --skip 跳过哈希校验
  '--skip',
  '-p', // --purge 卸载时彻底清理
  '--purge',
  '-f', // --force 强制
  '--force',
  '-k', // --no-cache (update/cleanup)
  '-a', // --all / --arch 的短参，取决于具体子命令
  '--all',
]);

/** 把字符串或数组形式的名称输入规范化为合法名称列表。 */
export function toNameList(value: unknown, label = '应用名称'): string[] {
  const raw = typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value : null;
  if (!raw) {
    throw new AppError('INVALID_PARAM', `${label}不能为空。`);
  }
  const list = raw
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0)
    .map((item) => (item === '*' ? '*' : assertName(item, label)));
  if (list.length === 0) {
    throw new AppError('INVALID_PARAM', `${label}不能为空。`);
  }
  if (list.length > 50) {
    throw new AppError('INVALID_PARAM', `一次最多处理 50 个${label}。`);
  }
  return list;
}

export const ALLOWED_ARCHITECTURES = ['64bit', '32bit', 'arm64'] as const;
export type Architecture = (typeof ALLOWED_ARCHITECTURES)[number];

export function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && NAME_PATTERN.test(value);
}

export function isConfigKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && CONFIG_KEY_PATTERN.test(value);
}

export function assertName(value: unknown, label: string): string {
  if (!isName(value)) {
    throw new AppError('INVALID_PARAM', `${label}不合法：只允许字母、数字与 . _ + -，且必须以字母或数字开头。`);
  }
  return value;
}

export function assertConfigKey(value: unknown): string {
  if (!isConfigKey(value)) {
    throw new AppError('INVALID_PARAM', '配置项名称不合法：只允许字母、数字与 . _ -，且必须以字母开头。');
  }
  return value;
}

export function assertFlag(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ALLOWED_FLAGS.has(value)) {
    throw new AppError('INVALID_PARAM', `${label}不是受支持的参数。`);
  }
  return value;
}

/** 只有白名单内的开关才能进入 argv；这是最终兜底。 */
export function assertOnlySafeArgs(args: string[]): string[] {
  for (const arg of args) {
    if (arg.startsWith('-') && !ALLOWED_FLAGS.has(arg)) {
      throw new AppError('INVALID_PARAM', `参数 ${arg} 未被允许执行。`);
    }
    if (arg.length > 512) {
      throw new AppError('INVALID_PARAM', '参数长度超出限制。');
    }
  }
  return args;
}

export function assertAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('INVALID_PARAM', `${label}不能为空。`);
  }
  const raw = value.trim().replace(/^"|"$/g, '');
  if (!isAbsolute(raw)) {
    throw new AppError('INVALID_PARAM', `${label}必须是绝对路径（例如 D:\\scoop）。`);
  }
  if (raw.includes('"') || raw.includes('`') || raw.includes('\u0000')) {
    throw new AppError('INVALID_PARAM', `${label}包含非法字符。`);
  }
  return raw;
}

/**
 * 校验 Scoop 代理配置值。
 * 合法形态：
 *   - `current` / `none`：Scoop 的两个特殊值
 *   - `http(s)://[user:pass@]host[:port]`
 *   - `[user:pass@]host[:port]`
 */
export function isProxyValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v === 'current' || v === 'none') return true;
  if (v.length === 0 || v.length > 256) return false;
  return /^(https?:\/\/)?([^\s@/]+(:[^\s@/]*)?@)?[A-Za-z0-9.\-_]+(:\d{1,5})?$/.test(v);
}

export function assertProxyValue(value: unknown): string {
  if (!isProxyValue(value)) {
    throw new AppError(
      'INVALID_PARAM',
      '代理地址格式不合法。可填写 host:port、http://user:pass@host:port，或使用 current（跟随系统代理）/ none（不使用代理）。',
    );
  }
  return String(value).trim();
}

export function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function toInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function assertArchitecture(value: unknown): Architecture {
  const v = String(value ?? '');
  if (!ALLOWED_ARCHITECTURES.includes(v as Architecture)) {
    throw new AppError('INVALID_PARAM', `架构只能是 ${ALLOWED_ARCHITECTURES.join(' / ')} 之一。`);
  }
  return v as Architecture;
}

/** 读取 JSON 请求体，失败时抛出可读错误而不是让 Hono 抛原始异常。 */
export async function safeJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError('INVALID_PARAM', '请求体必须是 JSON 对象。');
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_PARAM', '请求体不是合法的 JSON。');
  }
}
