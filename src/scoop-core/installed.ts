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
import { createLogger } from './logger.js';
import { dirStamp, listDirs, listFiles, readJson, statSafe } from '../utils/fsx.js';
import { detectScoop } from './locator.js';
import { manifestIndex } from './manifest.js';

const logger = createLogger('apps');

// ==========================================================================
//  Scoop status 命令输出解析 & 权威结果缓存
// --------------------------------------------------------------------------
//
//  为什么需要：
//    computeUpdates 的 manifest 比对和 scoop status -l 用的是同一份本地 bucket
//    数据——bucket 未 git pull 时两者都会滞后。而 `scoop status`（不带 -l）会
//    联网拉取 bucket 最新 manifest，能拿到真正最新的 available 版本、hold 状态、
//    缺失依赖等权威信息。代价是慢（PowerShell 冷启动 + 遍历 + 可能的网络 I/O）。
//
//  因此采取「任务触发 + 结果缓存」的模式：
//    - POST /apps/status 任务（scoop status）是唯一的真实数据源；
//    - 任务完成后解析 stdout，填充本缓存；
//    - GET /overview 与 GET /apps/updates 优先用新鲜缓存，否则回退到毫秒级
//      的 manifest 比对（让概览接口始终快速可用）；
//    - bucket 更新任务完成后自动触发 scoop status 后台刷新，保证数据源跟随 bucket 同步。
//
//  输出格式（实测）：
//    WARN  Scoop bucket(s) out of date. Run 'scoop update' to get the latest changes.
//
//    Name       Installed Version Latest Version Missing Dependencies Info
//    ----       ----------------- -------------- -------------------- ----
//    fastgithub 2.1.5                            sudo
//    jackett    0.24.2619         0.24.2624
//
//  注意：
//    - 列宽按最长内容自适应，不做固定偏移，用「≥2 个连续空格」切列；
//    - Latest Version 为空（应用已是最新）的行应被跳过；
//    - Info 列内容多样（hold、sudo、arch mismatch 等），暂不细分类型，后续可扩展。
// ==========================================================================

/** 缓存 TTL：5 分钟。scoop status 结果本质是 bucket manifest 的快照，5 分钟窗口内重跑几乎不会有新发现。 */
const SCOOP_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

interface ScoopStatusCacheEntry {
  /** scoop status 命令 stdout（可能含 WARN 头、空行、表头/表尾） */
  stdout: string;
  /** 解析出的可更新条目 */
  items: UpdateCandidate[];
  cachedAt: number;
}

let scoopStatusCache: ScoopStatusCacheEntry | null = null;

/** 后台 scoop status 是否正在进行：避免狂点刷新 / 反复 resync 把多条 status 排进串行队列 */
let statusRefreshing = false;

export function getScoopStatusCache(): ScoopStatusCacheEntry | null {
  return scoopStatusCache && Date.now() - scoopStatusCache.cachedAt < SCOOP_STATUS_CACHE_TTL_MS
    ? scoopStatusCache
    : null;
}

/**
 * 主动作废 scoop status 缓存。
 *
 * 「重新同步」的语义是"重新拿一次真相"。这个缓存有 5 分钟 TTL，
 * 不清掉的话，用户在终端里 scoop update 完之后再点同步，
 * 可更新列表仍然是旧的（表现为"刷新了但没变化"）。
 */
export function clearScoopStatusCache(): void {
  scoopStatusCache = null;
}

export function setScoopStatusCache(stdout: string): ScoopStatusCacheEntry {
  const items = parseScoopStatus(stdout);
  scoopStatusCache = { stdout, items, cachedAt: Date.now() };
  logger.debug(`scoop status 缓存已更新：${items.length} 个可更新应用`);
  return scoopStatusCache;
}

/**
 * 真实执行 `scoop status` 命令（带联网获取），并把 stdout 写入权威缓存。
 *
 * 这是一个 "fire-and-forget" 友好的后台刷新工具：它用 scoop-runner 的 run()，
 * 默认会进入串行队列（serial=true），所以不会和正在进行的 scoop 命令冲突，
 * 而是排队等待。命令执行期间如果有 GET /overview 进来，会继续用旧缓存（或
 * 回退到 manifest 比对），不会阻塞。
 *
 * 调用场景：
 *   - bucket.update 任务成功完成后（bucket 刚 git pull，拿权威结果最有意义）
 *   - 未来需要定期后台刷新的入口
 *
 * 返回 Promise 但调用方通常不需要 await。
 */
export async function refreshScoopStatusCache(): Promise<void> {
  // 重入保护：一次刷新可能要几十秒（联网），期间重复触发没有意义，只会把
  // 多条 `scoop status` 排进串行队列、把后面的真实操作全部堵住。
  if (statusRefreshing) return;
  statusRefreshing = true;
  try {
    const { run } = await import('./runner.js');
    const result = await run({
      label: '后台 scoop status 刷新',
      args: ['status'],
      serial: true,
      timeoutMs: 15 * 60 * 1000,
    });
    if (result.code === 0 && !result.canceled && !result.timedOut && result.stdout) {
      setScoopStatusCache(result.stdout);
    } else {
      logger.debug(`后台 scoop status 刷新跳过：code=${result.code} canceled=${result.canceled} timedOut=${result.timedOut}`);
    }
  } catch (error) {
    logger.warn(`后台 scoop status 刷新失败：${(error as Error).message}`);
  } finally {
    statusRefreshing = false;
  }
}

/**
 * 解析 `scoop status` 的固定宽度文本表。
 *
 * 先在 stdout 中定位表头行，根据「每列起始字符位置」切列，这样即使某一整列
 * 完全为空（比如 Latest Version 为空、Info 为空）也不会丢失，完全规避了
 * 「≥2 空格切列 + 中间空格被吞」的经典坑。
 *
 * 表头固定 5 列（scoop status）：
 *   Name | Installed Version | Latest Version | Missing Dependencies | Info
 *   某些老版本可能只有前 3 列，本函数动态容忍。
 *
 * Latest Version 为空（应用已是最新）的行跳过，不加入结果。
 */
export function parseScoopStatus(stdout: string): UpdateCandidate[] {
  const lines = stdout.split(/\r?\n/);

  // 先找表头行
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*Name\s+Installed/.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const header = lines[headerIdx];
  const SEP_NAMES = ['Name', 'Installed Version', 'Latest Version', 'Missing Dependencies', 'Info'];
  // 计算每列起始位置，以及末列的结束位置（整行长度）
  const colStarts: number[] = [];
  for (const name of SEP_NAMES) {
    const idx = header.indexOf(name);
    if (idx === -1) break; // 老版本 scoop 可能只有前几列
    colStarts.push(idx);
  }
  colStarts.push(header.length); // 末列的结束位置

  const items: UpdateCandidate[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    // 分隔行全是 -
    if (/^[-\s─━]+$/.test(line)) continue;
    // 避免异常 WARN / NOTE 行被误解析
    if (/^(WARN|ERROR|INFO)\b/i.test(line)) continue;

    const cols: string[] = [];
    for (let c = 0; c < colStarts.length - 1; c++) {
      const piece = raw.slice(colStarts[c], colStarts[c + 1]).trim();
      cols.push(piece);
    }
    if (cols.length < 3) continue;

    const [name, installed, latest] = cols;
    if (!name) continue;
    // Latest Version 为空 / 全是 - 表示已是最新
    if (!latest || /^[-]+$/.test(latest)) continue;

    const restInfo = cols.slice(3).join(' ');
    items.push({
      name,
      installed: installed || '',
      available: latest,
      bucket: null, // scoop status 输出不含 bucket 名
      global: false,
      hold: /hold|locked/i.test(restInfo),
    });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

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
  /**
   * apps 目录快照。
   *
   * 刻意不用"固定 N 秒 TTL"：Scoop 可能被用户在命令行里直接 install/uninstall，
   * 时间型缓存在窗口期内必然与磁盘不符。改为以 apps 目录的直接子项快照为准 —
   * 每次 list 只付出一次 readdir 级别的廉价校验（dirStamp），目录一变（本程序
   * 操作或外部命令行操作）就自动重扫；目录没变才复用上次的完整扫描结果。
   */
  private stamp = '';

  /** 显式失效：变更类任务结束后调用，强制下一次 list 重扫。 */
  invalidate(): void {
    this.cache = null;
    this.stamp = '';
  }

  /** 计算用户/全局两个 apps 目录的组合快照；路径本身也纳入，便于切换根目录时失效。 */
  private computeStamp(root: string | null, globalRoot: string | null): string {
    if (!root) return 'no-scoop';
    const parts = [`u:${root}:${dirStamp(join(root, 'apps'))}`];
    if (globalRoot && globalRoot.toLowerCase() !== root.toLowerCase()) {
      parts.push(`g:${globalRoot}:${dirStamp(join(globalRoot, 'apps'))}`);
    }
    return parts.join('|');
  }

  /**
   * @param force 跳过快照校验强制重扫磁盘（对应前端的「重新扫描」）
   */
  async list(force = false): Promise<InstalledApp[]> {
    const env = await detectScoop();
    if (!env.installed || !env.root) {
      this.cache = [];
      this.stamp = 'no-scoop';
      return this.cache;
    }

    const nextStamp = this.computeStamp(env.root, env.globalRoot);
    if (!force && this.cache && nextStamp === this.stamp) {
      return this.cache;
    }

    const apps: InstalledApp[] = [];
    apps.push(...(await this.scanRoot(env.root, false)));

    if (env.globalRoot && env.globalRoot.toLowerCase() !== env.root.toLowerCase()) {
      apps.push(...(await this.scanRoot(env.globalRoot, true)));
    }

    apps.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = apps;
    this.stamp = nextStamp;
    logger.debug(`已安装应用扫描完成：${apps.length} 个（force=${force}）`);
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
  /**
   * 数据来源：
   *   'status'   → `scoop status` 的权威结果（联网，覆盖 bucket 未 git pull 的情况）
   *   'manifest' → 本地 bucket 索引比对（毫秒级，但 bucket 未更新时会滞后）
   * 前端据此显示来源徽标，并在「重新同步」后轮询等待权威结果回填。
   */
  source: 'status' | 'manifest';
  /** source === 'status' 时为那次 status 的完成时间，否则 null */
  cachedAt: number | null;
}

/**
 * 计算可更新应用。
 *
 * 数据源按优先级选择：
 *   1) 新鲜的 scoop status 命令结果缓存（5 分钟 TTL）——权威，因为 `scoop status`
 *      会联网拉取 bucket 最新 manifest，结果与命令行用户看到的完全一致；
 *   2) 回退到本地 bucket manifest 比对——毫秒级响应，但 bucket 未 git pull 时会滞后。
 *
 * 注意：这里**绝不**同步调用 `scoop status`——它需要 PowerShell 冷启动 + 遍历 +
 * 可能的网络 I/O，可能阻塞 15+ 秒。真实的 scoop status 运行由后台任务（POST /apps/status
 * 或 bucket.update 完成后自动触发）完成，结果通过 scoopStatusCache 注入。
 *
 * @param force 强制重扫已安装应用并重建 bucket 索引；对 scoop status 缓存无影响
 *              （那是独立的命令结果，不受目录快照或 manifest 索引重建影响）
 */
export async function computeUpdates(force = false): Promise<UpdateSummary> {
  const cachedStatus = getScoopStatusCache();
  if (cachedStatus) {
    return {
      items: cachedStatus.items,
      indexBuiltAt: cachedStatus.cachedAt,
      indexEntries: cachedStatus.items.length,
      note: `数据来自 scoop status 权威结果（${Math.round((Date.now() - cachedStatus.cachedAt) / 1000)} 秒前）。`,
      source: 'status',
      cachedAt: cachedStatus.cachedAt,
    };
  }

  const apps = await installedApps.list(force);
  await manifestIndex.ensure(force);

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
        : '结果基于本地 bucket 数据，可能滞后于实际最新版本。建议执行一次「检查更新状态」以获取权威结果。',
    source: 'manifest',
    cachedAt: null,
  };
}
