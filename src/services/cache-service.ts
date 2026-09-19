/**
 * 下载缓存与 Scoopfile 导出 / 导入。
 */

import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import { AppError } from '../server/errors.js';
import { JOBS_FILE } from '../config.js';
import { dirSizeSync, listNames, writeText } from '../utils/fsx.js';
import { assertName } from '../utils/validate.js';
import { detectScoop, requireScoopEnvironment } from './scoop-locator.js';
import { runOrThrow } from './scoop-runner.js';

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

export function buildCleanupArgs(apps: string[]): string[] {
  if (apps.length === 0) return ['cleanup', '*'];
  return ['cleanup', ...apps.map((app) => (app === '*' ? '*' : assertName(app, '应用名称')))];
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

  let appCount = 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) appCount = parsed.length;
  } catch {
    throw new AppError('COMMAND_FAILED', '导出结果不是合法 JSON，已保留原始文本供排查。', { detail: raw.slice(0, 2000) });
  }

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
  if (!Array.isArray(parsed)) {
    throw new AppError('INVALID_PARAM', 'Scoopfile 必须是 JSON 数组（每项包含 Name / Source 字段）。');
  }

  const file = join(dirname(JOBS_FILE), 'import-Scoopfile.json');
  if (!writeText(file, content)) {
    throw new AppError('INTERNAL', '无法写入临时 Scoopfile，请检查数据目录权限。');
  }
  return { file, appCount: parsed.length };
}
