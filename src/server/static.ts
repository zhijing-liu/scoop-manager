/**
 * 静态资源服务。
 *
 * 同一套代码需要覆盖三种运行形态：
 *   1. 开发态：`public/` 位于源码树中，直接读磁盘；
 *   2. Node 构建态：`dist/server/static.js` 向上两级仍是项目根，读磁盘；
 *   3. Bun 单文件 exe：`public/` 通过 `--asset` 内嵌，由 Bun 映射到 `$bunfs`，
 *      对 `node:fs` 依然可见。
 *
 * 因为无法在编译期确定内嵌资源的确切挂载点，这里采用"候选路径 + 内嵌兜底"
 * 的两段式解析，并把最终结果暴露给 /api/health 便于排障。
 */

import { existsSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import { moduleDir, safeJoin } from '../utils/paths.js';
import { log } from '../utils/logger.js';
import { bunRuntime } from '../runtime.js';

const staticLogger = log.scope('static');

const MODULE_DIR = moduleDir(import.meta);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function candidateRoots(): string[] {
  return Array.from(
    new Set([
      join(MODULE_DIR, '..', '..', 'public'), // src/server -> 项目根/public ；dist/server -> 项目根/public
      join(MODULE_DIR, '..', 'public'),
      join(MODULE_DIR, 'public'),
      join(process.cwd(), 'public'),
      join(process.cwd(), 'dist', 'public'),
      // Bun 单文件编译态：内嵌资源被挂载到虚构文件系统的 root 下
      '/$bunfs/root/public',
      '/$bunfs/root/src/public',
      '/$bunfs/root/dist/public',
    ]),
  );
}

let resolvedRoot: string | null | undefined;
let resolvedSource: 'disk' | 'embedded' | 'none' = 'none';

/** 定位静态资源根目录。返回 null 表示只能依赖内嵌数据。 */
export function resolvePublicDir(): string | null {
  if (resolvedRoot !== undefined) return resolvedRoot;

  for (const candidate of candidateRoots()) {
    try {
      if (existsSync(join(candidate, 'index.html'))) {
        resolvedRoot = candidate;
        resolvedSource = 'disk';
        staticLogger.info(`静态资源目录: ${candidate}`);
        return resolvedRoot;
      }
    } catch {
      // 某些虚构路径在 existsSync 上会抛错，忽略后继续尝试
    }
  }

  const index = embeddedIndex();
  resolvedRoot = null;
  if (index && index.size > 0) {
    resolvedSource = 'embedded';
    staticLogger.info(`静态资源来自内嵌数据（${index.size} 个文件），运行时不再依赖外部目录。`);
    return null;
  }

  resolvedSource = 'none';
  staticLogger.warn(`未能定位静态资源目录，候选路径：${candidateRoots().join(' | ')}`);
  return null;
}

export function staticInfo(): { dir: string | null; source: 'disk' | 'embedded' | 'none'; candidates: string[] } {
  resolvePublicDir();
  return { dir: resolvedRoot ?? null, source: resolvedSource, candidates: candidateRoots() };
}

/** 内嵌文件索引：Bun 会给文件名附加内容哈希，这里做一次规范化映射。 */
let embeddedCache: Map<string, string> | null = null;

function embeddedIndex(): Map<string, string> | null {
  if (embeddedCache) return embeddedCache;
  const files = bunRuntime()?.embeddedFiles;
  if (!files || files.length === 0) return null;

  const map = new Map<string, string>();
  for (const file of files) {
    const raw = String(file.name).replace(/\\/g, '/');
    // 去掉形如 `style-a1b2c3d4.css` 中的 8 位内容哈希
    const normalized = raw
      .split('/')
      .map((segment) => segment.replace(/-[0-9a-f]{8}(\.[^.]+)$/i, '$1'))
      .join('/');
    const marker = normalized.lastIndexOf('public/');
    const key = marker >= 0 ? normalized.slice(marker + 'public/'.length) : normalized.split('/').pop() ?? normalized;
    map.set(key, raw);
  }
  embeddedCache = map;
  return map;
}

export interface AssetResult {
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

function contentTypeFor(relPath: string): string {
  return MIME_TYPES[extname(relPath).toLowerCase()] ?? 'application/octet-stream';
}

function cacheControlFor(relPath: string): string {
  // vendor 下的第三方库（如 Alpine.js）内容稳定，允许较长缓存；
  // 其余为应用自身资源，开发态必须即时生效，统一 no-cache。
  if (relPath.startsWith('vendor/')) return 'public, max-age=604800';
  return 'no-cache';
}

/** 把 URL 路径规整为相对 public 的安全相对路径，非法时返回 null。 */
function normalizeRelative(relPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(relPath);
    } catch {
      return relPath;
    }
  })();
  const clean = posix.normalize(decoded.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (clean.length === 0) return null;
  if (clean.startsWith('..') || clean.includes('\u0000')) return null;
  return clean;
}

/** 读取资源内容；不存在时返回 null。内嵌资源只能异步读取，故统一走异步入口。 */
export async function readAssetAsync(relPath: string): Promise<AssetResult | null> {
  const clean = normalizeRelative(relPath);
  if (!clean) return null;

  const dataDir = resolvePublicDir();
  if (dataDir) {
    const full = safeJoin(dataDir, clean);
    if (!full || !existsSync(full)) return null;
    try {
      const { readFile } = await import('node:fs/promises');
      const buffer = await readFile(full);
      return { body: buffer, contentType: contentTypeFor(clean), cacheControl: cacheControlFor(clean) };
    } catch (error) {
      staticLogger.warn(`读取静态资源失败 ${clean}: ${(error as Error).message}`);
      return null;
    }
  }

  const blobName = embeddedIndex()?.get(clean);
  if (!blobName) return null;
  const blob = (bunRuntime()?.embeddedFiles ?? []).find((candidate) => candidate.name === blobName);
  if (!blob) return null;
  const buffer = Buffer.from(await blob.arrayBuffer());
  return { body: buffer, contentType: contentTypeFor(clean), cacheControl: cacheControlFor(clean) };
}

/** 该路径是否更像一个静态资源请求（有扩展名）而不是前端路由。 */
export function looksLikeAsset(relPath: string): boolean {
  const clean = normalizeRelative(relPath);
  if (!clean) return false;
  const lastSegment = clean.split('/').pop() ?? '';
  return lastSegment.includes('.');
}
