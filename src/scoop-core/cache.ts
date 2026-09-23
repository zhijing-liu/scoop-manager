/**
 * 下载缓存与 Scoopfile 导出 / 导入。
 *
 * cleanup 命令的参数构建已迁移到 scoop-options.ts（单一数据源）。
 * 本文件只保留 cache rm 和 Scoopfile 相关逻辑。
 */

import { dirname, join } from 'node:path';
import { rmSync, statSync } from 'node:fs';
import { AppError } from './errors.js';
import { JOBS_FILE } from '../config.js';
import { dirSizeSync, listNames, writeText } from '../utils/fsx.js';
import { assertName } from '../utils/validate.js';
import { detectScoop, requireScoopEnvironment } from './locator.js';
import { runOrThrow } from './runner.js';

export { buildFlags as buildCleanupArgs } from './options.js';

export interface CacheEntry {
  name: string;
  size: number;
  type: 'file' | 'dir';
  mtime: number | null;
}

export interface CacheStats {
  /** 缓存目录绝对路径 */
  path: string | null;
  totalBytes: number;
  totalEntries: number;
  entries: CacheEntry[];
  /** 是否因条目过多而截断展示 */
  truncated: boolean;
}

const MAX_ENTRIES = 300;

export async function cacheStats(): Promise<CacheStats> {
  const env = await detectScoop();
  if (!env.installed || !env.root) {
    return { path: null, totalBytes: 0, totalEntries: 0, entries: [], truncated: false };
  }

  const cacheDir = join(env.root, 'cache');
  const names = listNames(cacheDir);
  const entries: CacheEntry[] = [];
  let totalBytes = 0;

  for (const name of names) {
    const full = join(cacheDir, name);
    try {
      const stat = statSync(full);
      const isDir = stat.isDirectory();
      // 缓存里既有单文件也有目录（例如 aria2 的分片目录），都要统计
      const size = isDir ? dirSizeSync(full, { maxDepth: 3, maxFiles: 5000 }).bytes : stat.size;
      totalBytes += size;
      entries.push({ name, size, type: isDir ? 'dir' : 'file', mtime: stat.mtimeMs });
    } catch {
      // 缓存文件可能正被下载进程占用，跳过即可
    }
  }

  entries.sort((a, b) => b.size - a.size);
  return {
    path: cacheDir,
    totalBytes,
    totalEntries: entries.length,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
  };
}

export function buildCacheRemoveArgs(target?: string | null): string[] {
  if (!target) return ['cache', 'rm', '*'];
  return ['cache', 'rm', assertName(target, '缓存条目名称')];
}

// buildCleanupArgs 已迁移到 scoop-options.ts（单一数据源）
// 如需构建 cleanup 命令参数，请直接使用 scoop-options 中的 buildFlags()

/**
 * 统计 Scoopfile 里的应用数。
 *
 * `scoop export` 产出的是 `{ buckets: [...], apps: [...] }` 对象（本机实测），
 * 早期格式或手写文件则可能是纯应用数组。两种都要认 ——
 * 只认数组会把「导出后原样导入」这条最基本的闭环堵死。
 * 返回 null 表示格式无法识别。
 */
export function countScoopfileApps(parsed: unknown): number | null {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === 'object') {
    const apps = (parsed as { apps?: unknown }).apps;
    if (Array.isArray(apps)) return apps.length;
  }
  return null;
}

/**
 * 导出 Scoopfile。
 *
 * 使用官方 `scoop export`——这是唯一被官方明确保证输出 JSON 的命令。
 * 同时落盘一份到数据目录，方便用户直接取用。
 */
export async function exportScoopfile(options: { includeConfig?: boolean } = {}): Promise<{ json: string; file: string | null; appCount: number }> {
  await requireScoopEnvironment();
  const args = options.includeConfig ? ['export', '-c'] : ['export'];
  const result = await runOrThrow({ args, label: '导出 Scoopfile', serial: false, timeoutMs: 60_000 });

  const raw = result.stdout.trim();
  if (raw.length === 0) {
    throw new AppError('COMMAND_FAILED', 'Scoop 未返回任何内容，可能没有已安装的应用，或导出过程被中断。');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new AppError('COMMAND_FAILED', '导出结果不是合法 JSON，已保留原始文本供排查。', { detail: raw.slice(0, 2000) });
  }
  // 注意：scoop export 输出的是 { buckets, apps } 对象而不是数组，
  // 因此这里不能再用 Array.isArray 判断，否则 appCount 恒为 0
  //（界面上会显示"已导出 0 个应用"）。
  const appCount = countScoopfileApps(parsed) ?? 0;

  const file = join(dirname(JOBS_FILE), 'Scoopfile.json');
  writeText(file, raw.endsWith('\n') ? raw : `${raw}\n`);
  return { json: raw, file, appCount };
}

/** 校验并落盘待导入的 Scoopfile。 */
export async function prepareImportFile(content: string): Promise<{ file: string; appCount: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AppError('INVALID_PARAM', 'Scoopfile 内容不是合法 JSON。');
  }
  // 兼容两种形态：scoop export 的 { buckets, apps } 对象，以及纯应用数组。
  // 交给 scoop import 的仍是原始文本，因此 buckets / config 也会被一并导入。
  const appCount = countScoopfileApps(parsed);
  if (appCount === null) {
    throw new AppError(
      'INVALID_PARAM',
      'Scoopfile 格式无法识别：应为应用数组，或包含 apps 数组的对象（与「导出 Scoopfile」的输出一致）。',
    );
  }

  // 文件名必须唯一：校验发生在建任务之前，两个并发导入会先后覆盖同一个固定文件，
  // 结果两个导入任务都去执行最后写入的那份内容（A 的请求导入了 B 的清单）。
  const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = join(dirname(JOBS_FILE), `import-Scoopfile-${unique}.json`);
  if (!writeText(file, content)) {
    throw new AppError('INTERNAL', '无法写入临时 Scoopfile，请检查数据目录权限。');
  }
  return { file, appCount };
}

/** 删除导入用的临时 Scoopfile。失败无所谓：残留在数据目录里不影响功能。 */
export function removeImportFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // 忽略
  }
}
