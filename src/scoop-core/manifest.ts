/**
 * Bucket manifest 索引。
 *
 * 为什么不用 `scoop search`：
 *   1. 它的输出是给人看的文本表格，没有 --json，解析极易随版本失效；
 *   2. 它依赖 bucket 的 git 仓库已更新，未更新就搜不到新应用；
 *   3. 每次调用都要冷启动一个 PowerShell（数百毫秒起）。
 *
 * 改为直接扫描 `<SCOOP>/buckets/<bucket>/bucket/*.json` 建立内存索引：
 * 首次全量扫描是百毫秒级，之后按目录快照增量重建，搜索是纯内存操作。
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createLogger } from './logger.js';
import { dirStamp, listDirs, listFiles } from '../utils/fsx.js';
import { detectScoop } from './locator.js';

const logger = createLogger('manifest');

export interface ManifestEntry {
  name: string;
  version: string;
  description: string;
  homepage: string;
  license: string;
  bucket: string;
  depends: string[];
  suggests: string[];
  bin: string[];
  /** manifest 文件 mtime */
  updatedAt: number;
}

export interface SearchResult {
  items: ManifestEntry[];
  total: number;
  took: number;
  indexReady: boolean;
}

export interface IndexStats {
  entries: number;
  buckets: string[];
  builtAt: number | null;
  building: boolean;
  took: number | null;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}

function asLicense(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const identifier = (value as { identifier?: unknown }).identifier;
    if (typeof identifier === 'string') return identifier;
  }
  return '';
}

/** 异步并发映射，避免一次打开上千个文件句柄。 */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

class ManifestIndex {
  private entries: ManifestEntry[] = [];
  private buckets: string[] = [];
  private builtAt: number | null = null;
  private lastBuildTook: number | null = null;
  private stamp = '';
  private building: Promise<void> | null = null;
  private lastStampCheck = 0;

  /** 目录快照检查的最小间隔，避免高频请求反复做 readdir。 */
  private readonly stampCheckInterval = 3000;

  get size(): number {
    return this.entries.length;
  }

  get isBuilding(): boolean {
    return this.building !== null;
  }

  stats(): IndexStats {
    return {
      entries: this.entries.length,
      buckets: [...this.buckets],
      builtAt: this.builtAt,
      building: this.isBuilding,
      took: this.lastBuildTook,
    };
  }

  invalidate(): void {
    this.stamp = '';
    // 必须同时清掉 builtAt：`<root>/buckets` 为空时 computeStamp() 返回的也是 ''，
    // 若只清 stamp，下一次 ensure() 会命中 `currentStamp === this.stamp` 直接返回，
    // 于是删掉最后一个 bucket 之后，搜索结果里仍然留着它带来的应用。
    this.builtAt = null;
    this.lastStampCheck = 0;
    logger.info('索引已标记失效');
  }

  /** 确保索引可用；必要时重建。 */
  async ensure(force = false): Promise<void> {
    // 守卫要在第一个 await 之前登记：否则并发调用会各自通过检查，
    // 冷启动时（/search 与 /overview 同时打进来）重复做整轮全量扫描。
    if (this.building) return this.building;

    const pending = this.rebuildIfNeeded(force).finally(() => {
      if (this.building === pending) this.building = null;
    });
    this.building = pending;
    return pending;
  }

  private async rebuildIfNeeded(force: boolean): Promise<void> {
    const env = await detectScoop();
    if (!env.installed || !env.root) {
      this.entries = [];
      this.buckets = [];
      this.stamp = 'no-scoop';
      return;
    }

    const now = Date.now();
    if (!force && this.builtAt !== null && now - this.lastStampCheck < this.stampCheckInterval) {
      return;
    }

    const currentStamp = computeStamp(env.root);
    this.lastStampCheck = now;
    if (!force && currentStamp === this.stamp && this.builtAt !== null) {
      return;
    }

    await this.build(env.root, currentStamp);
  }

  private async build(root: string, stamp: string): Promise<void> {
    const started = Date.now();
    const bucketsDir = join(root, 'buckets');
    const buckets = listDirs(bucketsDir);

    const jobs: Array<{ bucket: string; dir: string; file: string }> = [];
    for (const bucket of buckets) {
      const manifestDir = join(bucketsDir, bucket, 'bucket');
      for (const file of listFiles(manifestDir, '.json')) {
        // 以 _ 开头的文件是 bucket 的元数据（例如 _bucket.json），不是应用
        if (file.startsWith('_')) continue;
        jobs.push({ bucket, dir: manifestDir, file });
      }
    }

    const parsed = await mapLimit(jobs, 64, async (job) => {
      const full = join(job.dir, job.file);
      try {
        const raw = await readFile(full, 'utf8');
        const manifest = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Record<string, unknown>;
        return toEntry(manifest, job.file.slice(0, -'.json'.length), job.bucket, full);
      } catch {
        // 单个 manifest 损坏不影响整体索引
        return null;
      }
    });

    this.entries = parsed.filter((entry): entry is ManifestEntry => entry !== null);
    this.buckets = buckets;
    this.stamp = stamp;
    this.builtAt = Date.now();
    this.lastBuildTook = this.builtAt - started;
    logger.info(`索引重建完成：${this.entries.length} 个应用 / ${buckets.length} 个 bucket，耗时 ${this.lastBuildTook}ms`);
  }

  search(query: string, options: { bucket?: string | null; limit?: number; offset?: number } = {}): SearchResult {
    const started = Date.now();
    const limit = options.limit ?? 60;
    const offset = options.offset ?? 0;
    const keyword = query.trim().toLowerCase();
    const bucketFilter = options.bucket?.trim().toLowerCase() || null;

    const scored: Array<{ entry: ManifestEntry; score: number }> = [];
    for (const entry of this.entries) {
      if (bucketFilter && entry.bucket.toLowerCase() !== bucketFilter) continue;

      if (keyword.length === 0) {
        scored.push({ entry, score: 0 });
        continue;
      }

      const name = entry.name.toLowerCase();
      let score = 0;
      if (name === keyword) score = 100;
      else if (name.startsWith(keyword)) score = 80;
      else if (name.includes(keyword)) score = 60;
      else if (entry.description.toLowerCase().includes(keyword)) score = 40;
      else if (entry.bin.some((bin) => bin.toLowerCase().includes(keyword))) score = 20;

      if (score > 0) scored.push({ entry, score });
    }

    scored.sort((a, b) => (b.score - a.score) || a.entry.name.localeCompare(b.entry.name));

    return {
      items: scored.slice(offset, offset + limit).map((item) => item.entry),
      total: scored.length,
      took: Date.now() - started,
      indexReady: this.builtAt !== null,
    };
  }

  /** 按名称取详情；同名优先返回 main / 精确匹配的第一个。 */
  find(name: string): ManifestEntry[] {
    const keyword = name.toLowerCase();
    return this.entries.filter((entry) => entry.name.toLowerCase() === keyword);
  }

  suggest(prefix: string, limit = 10): ManifestEntry[] {
    const keyword = prefix.toLowerCase();
    return this.entries.filter((entry) => entry.name.toLowerCase().startsWith(keyword)).slice(0, limit);
  }

  /** 按 bucket 统计 manifest 数量。 */
  countByBucket(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.entries) {
      counts[entry.bucket] = (counts[entry.bucket] ?? 0) + 1;
    }
    return counts;
  }

  bucketNames(): string[] {
    return [...this.buckets];
  }
}

function toEntry(manifest: Record<string, unknown>, name: string, bucket: string, fullPath: string): ManifestEntry {
  let version = typeof manifest.version === 'string' ? manifest.version : '';
  // 分架构 manifest：顶层 version 可能是占位符，优先取 64bit
  const architecture = manifest.architecture;
  if (architecture && typeof architecture === 'object') {
    const arch = architecture as Record<string, { version?: unknown }>;
    const preferred = arch['64bit'] ?? arch['arm64'] ?? arch['32bit'];
    if (preferred && typeof preferred.version === 'string') version = preferred.version;
  }

  let updatedAt = 0;
  try {
    updatedAt = statSync(fullPath).mtimeMs;
  } catch {
    updatedAt = 0;
  }

  return {
    name,
    version,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    homepage: typeof manifest.homepage === 'string' ? manifest.homepage : '',
    license: asLicense(manifest.license),
    bucket,
    depends: asStringArray(manifest.depends),
    suggests: asStringArray(manifest.suggests),
    bin: asStringArray(manifest.bin),
    updatedAt,
  };
}

/** 目录快照：任一 bucket 的 bucket/ 目录发生变化都会导致 stamp 变化。 */
function computeStamp(root: string): string {
  const bucketsDir = join(root, 'buckets');
  const buckets = listDirs(bucketsDir);
  return buckets
    .map((bucket) => `${bucket}:${dirStamp(join(bucketsDir, bucket, 'bucket'))}`)
    .sort()
    .join('|');
}

export const manifestIndex = new ManifestIndex();
