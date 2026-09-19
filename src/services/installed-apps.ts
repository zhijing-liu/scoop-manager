/**
 * 已安装应用扫描。
 *
 * 同样不走 `scoop list` 的文本表格，而是直接读磁盘：
 *   <root>/apps/<app>/current/manifest.json  -> 版本、描述、主页
 *   <root>/apps/<app>/current/install.json   -> bucket、架构、hold 状态
 *   <root>/apps/<app>/current 的 mtime       -> 最近更新时间
 *
 * 整体一次目录遍历即可拿到全部信息，耗时在毫秒级，且不受 PowerShell 冷启动影响。
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createLogger } from '../utils/logger.js';
import { listDirs, listFiles, readJson, statSafe } from '../utils/fsx.js';
import { detectScoop } from './scoop-locator.js';
import { manifestIndex } from './manifest-index.js';

const logger = createLogger('apps');

export interface InstalledApp {
  name: string;
  version: string;
  bucket: string | null;
  architecture: string | null;
  hold: boolean;
  /** 是否安装在全局（管理员）目录 */
  global: boolean;
  /** 安装目录（current 软链接所在位置） */
  path: string;
  description: string;
  homepage: string;
  updatedAt: number | null;
  /** 该应用提供的 shim 命令名 */
  shims: string[];
  /** 是否为 scoop 自身 */
  isScoop: boolean;
}

interface InstallInfo {
  bucket?: unknown;
  architecture?: unknown;
  hold?: unknown;
  url?: unknown;
}

class InstalledAppsService {
  private cache: InstalledApp[] | null = null;
  private cachedAt = 0;
  /** 缓存有效期：变更类任务结束后会主动 invalidate，这里只是兜底 */
  private readonly ttl = 3000;

  invalidate(): void {
    this.cache = null;
    this.cachedAt = 0;
  }

  async list(force = false): Promise<InstalledApp[]> {
    if (!force && this.cache && Date.now() - this.cachedAt < this.ttl) {
      return this.cache;
    }

    const env = await detectScoop();
    if (!env.installed || !env.root) {
      this.cache = [];
      this.cachedAt = Date.now();
      return this.cache;
    }

    const apps: InstalledApp[] = [];
    apps.push(...(await this.scanRoot(env.root, false)));

    if (env.globalRoot && env.globalRoot.toLowerCase() !== env.root.toLowerCase()) {
      apps.push(...(await this.scanRoot(env.globalRoot, true)));
    }

    apps.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = apps;
    this.cachedAt = Date.now();
    logger.debug(`已安装应用扫描完成：${apps.length} 个`);
    return apps;
  }

  async get(name: string, globalOnly = false): Promise<InstalledApp | null> {
    const apps = await this.list();
    const keyword = name.toLowerCase();
    const matched = apps.filter((app) => app.name.toLowerCase() === keyword && (!globalOnly || app.global));
    return matched[0] ?? null;
  }

  private async scanRoot(root: string, isGlobal: boolean): Promise<InstalledApp[]> {
    const appsDir = join(root, 'apps');
    const names = listDirs(appsDir);
    if (names.length === 0) return [];

    const shimMap = this.buildShimMap(root);
    const results: InstalledApp[] = [];

    for (const name of names) {
      const currentDir = join(appsDir, name, 'current');
      const manifest = await this.readManifest(join(currentDir, 'manifest.json'));
      const installInfo = (await this.readInstallInfo(join(currentDir, 'install.json'))) ?? {};

      const version =
        (manifest && typeof manifest.version === 'string' && manifest.version) ||
        listDirs(join(appsDir, name, 'versions')).slice(-1)[0] ||
        '未知';

      const binNames = this.collectBinNames(manifest);
      const shims = new Set<string>();
      for (const candidate of [name, ...binNames]) {
        if (shimMap.has(candidate.toLowerCase())) shims.add(candidate);
      }

      results.push({
        name,
        version,
        bucket: typeof installInfo.bucket === 'string' ? installInfo.bucket : null,
        architecture: typeof installInfo.architecture === 'string' ? installInfo.architecture : null,
        hold: installInfo.hold === true,
        global: isGlobal,
        path: currentDir,
        description: manifest && typeof manifest.description === 'string' ? manifest.description : '',
        homepage: manifest && typeof manifest.homepage === 'string' ? manifest.homepage : '',
        updatedAt: statSafe(currentDir)?.mtimeMs ?? null,
        shims: [...shims].sort(),
        isScoop: name.toLowerCase() === 'scoop',
      });
    }

    return results;
  }

  private async readManifest(file: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      // 卸载过程中文件可能瞬时不可读，视为缺失即可
      return null;
    }
  }

  private async readInstallInfo(file: string): Promise<InstallInfo | null> {
    try {
      const raw = await readFile(file, 'utf8');
      return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as InstallInfo;
    } catch {
      return null;
    }
  }

  private collectBinNames(manifest: Record<string, unknown> | null): string[] {
    if (!manifest) return [];
    const bin = manifest['bin'];
    const names: string[] = [];
    const addFromValue = (value: unknown): void => {
      if (typeof value === 'string') {
        const base = value.split(/[\\/]/).pop() ?? value;
        names.push(base.replace(/\.(exe|cmd|bat|ps1|sh)$/i, ''));
        return;
      }
      if (Array.isArray(value)) {
        if (typeof value[0] === 'string') addFromValue(value[0]);
        return;
      }
    };
    if (typeof bin === 'string') addFromValue(bin);
    else if (Array.isArray(bin)) bin.forEach((item) => addFromValue(item));
    else if (bin && typeof bin === 'object') {
      for (const [key, value] of Object.entries(bin as Record<string, unknown>)) {
        names.push(key);
        addFromValue(value);
      }
    }
    return names.filter((name) => name.length > 0);
  }

  /** shims 目录一次扫描，构建 name(lower) -> 文件 的映射。 */
  private buildShimMap(root: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const file of listFiles(join(root, 'shims'))) {
      const base = file.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '');
      map.set(base.toLowerCase(), file);
    }
    return map;
  }
}

export const installedApps = new InstalledAppsService();

/** 供路由层复用：读取应用详情（含 manifest 原文）。 */
export async function readManifestRaw(appPath: string): Promise<Record<string, unknown> | null> {
  return readJson<Record<string, unknown>>(join(appPath, 'manifest.json'));
}

export interface UpdateCandidate {
  name: string;
  installed: string;
  available: string;
  bucket: string | null;
  global: boolean;
  hold: boolean;
}

export interface UpdateSummary {
  items: UpdateCandidate[];
  /** 索引信息，便于前端提示"数据可能滞后" */
  indexBuiltAt: number | null;
  indexEntries: number;
  note: string;
}

/**
 * 计算可更新应用。
 *
 * 与 `scoop status` 的区别：这里把「已安装版本」与「本地 bucket manifest 版本」
 * 直接比对，返回结构化 JSON 且耗时在毫秒级。代价是本地 bucket 未 git pull 时
 * 结果会滞后，因此前端需要提示用户先更新 bucket（或直接执行一次更新 bucket 任务）。
 */
export async function computeUpdates(): Promise<UpdateSummary> {
  const [apps] = await Promise.all([installedApps.list()]);
  await manifestIndex.ensure();

  const items: UpdateCandidate[] = [];
  for (const app of apps) {
    const candidates = manifestIndex.find(app.name);
    if (candidates.length === 0) continue;
    const preferred =
      (app.bucket ? candidates.find((entry) => entry.bucket.toLowerCase() === app.bucket?.toLowerCase()) : undefined) ?? candidates[0];
    if (!preferred || !preferred.version) continue;
    if (preferred.version === app.version) continue;
    items.push({
      name: app.name,
      installed: app.version,
      available: preferred.version,
      bucket: preferred.bucket,
      global: app.global,
      hold: app.hold,
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  const stats = manifestIndex.stats();
  return {
    items,
    indexBuiltAt: stats.builtAt,
    indexEntries: stats.entries,
    note:
      stats.entries === 0
        ? '本地 bucket 索引为空，请先添加 bucket 并执行一次「更新 Bucket」。'
        : '结果基于本地 bucket 数据，若长时间未更新 bucket，可能滞后于实际最新版本。',
  };
}
