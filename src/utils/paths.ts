/**
 * 跨运行时的路径工具。
 *
 * Node 与 Bun 对「当前模块目录」的暴露方式不同：
 *   - Bun:      import.meta.dir        -> 绝对路径
 *   - Node 20+: import.meta.dirname    -> 绝对路径
 *   - 兜底:     import.meta.url        -> file:// URL
 *
 * 编译产物与源码目录结构一致（src/server/static.ts -> dist/server/static.js），
 * 所以基于相对层级推导的资源路径在两种形态下都成立。
 */

import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function moduleDir(meta: ImportMeta): string {
  const candidate = meta as unknown as { dir?: unknown; dirname?: unknown; url?: unknown };
  if (typeof candidate.dir === 'string' && candidate.dir.length > 0) return candidate.dir;
  if (typeof candidate.dirname === 'string' && candidate.dirname.length > 0) return candidate.dirname;
  if (typeof candidate.url === 'string') return dirname(fileURLToPath(candidate.url));
  return process.cwd();
}

/**
 * 安全拼接：确保结果仍位于 base 之内，阻断 `../` 目录穿越。
 * 返回 null 表示请求非法。
 */
export function safeJoin(base: string, ...parts: string[]): string | null {
  const target = normalize(join(base, ...parts));
  const baseResolved = resolve(base);
  const rel = relative(baseResolved, resolve(target));
  if (rel === '') return target;
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

/** 把任意用户输入的路径规范化为绝对路径（不校验存在性）。 */
export function toAbsolute(p: string): string {
  const trimmed = p.trim().replace(/^"|"$/g, '');
  return isAbsolute(trimmed) ? normalize(trimmed) : resolve(trimmed);
}

/** 去掉 Windows 长路径前缀 `\\?\`，便于展示。 */
export function prettyPath(p: string): string {
  return p.replace(/^\\\\\?\\/, '');
}

export function withSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

/**
 * 把「反向代理子路径」规范化为 '' 或 '/xxx'（不带尾斜杠）。
 *
 * 接受用户可能写出的各种形式，统一收敛：
 *   '/scoop/'   -> '/scoop'
 *   'scoop'     -> '/scoop'
 *   '/' | ''    -> ''            （根路径部署，等价于不启用）
 *   '/a/b//'    -> '/a/b'
 *   '/scoop?x=1'-> ''            （含查询串/非法字符，视为无效）
 *
 * 只允许字母、数字与 . _ ~ - 组成的层级，避免把 URL 语义字符带进路径。
 */
export function normalizeBasePath(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  let raw = value.trim().replace(/^"|"$/g, '');
  if (raw.length === 0) return '';
  // 允许用户直接粘贴完整 URL，只取其路径部分
  try {
    if (/^https?:\/\//i.test(raw)) raw = new URL(raw).pathname;
  } catch {
    return '';
  }
  if (raw === '/' || raw === '.') return '';
  if (!raw.startsWith('/')) raw = `/${raw}`;
  const segments = raw.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return '';
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._~-]+$/.test(segment)) return '';
  }
  return `/${segments.join('/')}`;
}
