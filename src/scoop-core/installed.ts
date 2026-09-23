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
//    - Latest Version 为空（应用已是最新）的行**不能丢**：上面那行 fastgithub 就是
//      典型案例 —— 它没有新版可用，但 Missing Dependencies 列写着 sudo。
//      旧实现把这类行整行跳过，于是「缺依赖」「Install failed」在界面上永远看不到；
//    - 只有「有更新」的行才进可更新列表，其余行用于状态展示（见 ScoopStatusRow）；
//    - Info 列由 Scoop 用逗号拼多个条目（Held package / Install failed /
//      Deprecated / Manifest removed），逐条拆分后按关键词识别。
// ==========================================================================

/** 缓存 TTL：5 分钟。scoop status 结果本质是 bucket manifest 的快照，5 分钟窗口内重跑几乎不会有新发现。 */
const SCOOP_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * `scoop status` 表格里的一行。
 *
 * 与 UpdateCandidate 的区别：这里保留**所有**被 Scoop 报出来的行，
 * 包括那些「没有新版本可用、但有别的问题」的行。
 */
export interface ScoopStatusRow {
  name: string;
  installed: string;
  /** 最新版本；为空表示已是最新 */
  available: string;
  /** Missing Dependencies 列（Scoop 用 " | " 拼接多个依赖） */
  missingDeps: string[];
  /** Info 列的条目："Install failed" / "Held package" / "Deprecated" / "Manifest removed" */
  info: string[];
  hold: boolean;
}

interface ScoopStatusCacheEntry {
  /** scoop status 命令 stdout（可能含 WARN 头、空行、表头/表尾） */
  stdout: string;
  /** 解析出的可更新条目 */
  items: UpdateCandidate[];
  /**
   * 表格里的全部有效行（含没有新版可用的行）。
   *
   * 必须单独留一份：`scoop status` 只打印「有情况」的应用
   * （源码里的过滤条件见 scoop-status.ps1），而「缺依赖 / Install failed /
   * Held package」恰恰只出现在**没有更新**的行上 —— 旧实现把这类行整行跳过，
   * 于是这些状态在界面上永远看不到，命令行里却有。
   */
  rows: ScoopStatusRow[];
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
  const { updates, rows } = parseScoopStatus(stdout);
  scoopStatusCache = { stdout, items: updates, rows, cachedAt: Date.now() };
  logger.debug(`scoop status 缓存已更新：${updates.length} 个可更新 / 共 ${rows.length} 行状态`);
  return scoopStatusCache;
}

/**
 * 取「应用名（小写）→ scoop status 行」的映射，缓存过期或没跑过时返回 null。
 *
 * 返回 null 时调用方必须回退到本地清单比对 —— 这是本程序能在没跑过
 * `scoop status` 的情况下也显示缺依赖的原因。
 */
export function getScoopStatusRows(): Map<string, ScoopStatusRow> | null {
  const cache = getScoopStatusCache();
  if (!cache) return null;
  return new Map(cache.rows.map((row) => [row.name.toLowerCase(), row]));
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
 * 返回两份结果：
 *   updates —— 「有新版本」的行，供可更新列表使用；
 *   rows    —— 全部有效行，供状态展示（缺依赖 / Install failed）使用。
 */
export function parseScoopStatus(stdout: string): { updates: UpdateCandidate[]; rows: ScoopStatusRow[] } {
  const lines = stdout.split(/\r?\n/);

  // 先找表头行
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*Name\s+Installed/.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return { updates: [], rows: [] };

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
  const rows: ScoopStatusRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    // 分隔行全是 -
    if (/^[-\s─━]+$/.test(line)) continue;
    // 避免异常 WARN / NOTE 行被误解析
    if (/^(WARN|ERROR|INFO)\b/i.test(line)) continue;

    const cols: string[] = [];
    const lastCol = colStarts.length - 2;
    for (let c = 0; c <= lastCol; c++) {
      // 末列必须切到行尾：Format-Table 的列宽取「表头与所有单元格里的最大值」，
      // 表头里的 "Info" 只有 4 个字符，而内容可能是 "Install failed"（14 个）。
      // 按表头宽度截断会把末列切掉 —— 旧实现就是这样，所以 Install failed /
      // Held package 这类 Info 内容从来没被真正解析出来过。
      const piece = c === lastCol
        ? raw.slice(colStarts[c]).trim()
        : raw.slice(colStarts[c], colStarts[c + 1]).trim();
      cols.push(piece);
    }
    if (cols.length < 3) continue;

    const [name, installed, latest] = cols;
    if (!name) continue;

    // 第 4 列缺依赖（Scoop 用 " | " 拼多个）、第 5 列 Info（逗号拼多个）
    const missingDeps = (cols[3] ?? '')
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
    const info = (cols[4] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const hold = /hold|locked/i.test([...missingDeps, ...info].join(' '));

    // 整行先收下：没有更新版本的行同样可能带着「缺依赖 / Install failed」
    rows.push({
      name,
      installed: installed || '',
      available: latest ?? '',
      missingDeps,
      info,
      hold,
    });

    // Latest Version 为空 / 全是 - 表示已是最新：不进可更新列表，但上面已留下状态行
    if (!latest || /^[-]+$/.test(latest)) continue;

    items.push({
      name,
      installed: installed || '',
      available: latest,
      bucket: null, // scoop status 输出不含 bucket 名
      global: false,
      hold,
    });
  }

  return {
    updates: items.sort((a, b) => a.name.localeCompare(b.name)),
    rows,
  };
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
  /**
   * 安装不完整：`apps/<name>` 目录在，但 `current/install.json` 读不出来。
   * 等价于 `scoop status` 里的 "Install failed"（判定逻辑与 Scoop 的 failed() 一致），
   * 典型成因是安装/更新中断留下的残骸。未启用 NO_JUNCTION 时该判定是精确的。
   */
  installFailed: boolean;
  /** `current/manifest.json` 缺失：清单已从 bucket 移除，或安装本身不完整 */
  manifestRemoved: boolean;
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
      // 保留 null / {} 的区别：读不到 install.json 就是 Scoop 眼里的「安装失败」
      const rawInstallInfo = await this.readInstallInfo(join(currentDir, 'install.json'));
      const installInfo = rawInstallInfo ?? {};

      const version =
        (manifest && typeof manifest.version === 'string' && manifest.version) ||
        listDirs(join(appsDir, name, 'versions')).slice(-1)[0] ||
        '未知';

      /**
       * scoop 自身不是"安装"来的：它是 git 克隆 + `bin/scoop.ps1`，
       * 既没有 `install.json` 也没有 `manifest.json`。
       * 不排除它就会被判成残骸 —— 界面打上「安装异常」并给出「清理残骸」按钮，
       * 一点就把整套 Scoop 删了。`scoop status` 自己也是这么排除的
       * （scoop-status.ps1 里的 `Where-Object name -NE 'scoop'`）。
       */
      const isScoop = name.toLowerCase() === 'scoop';

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
        isScoop,
        installFailed: !isScoop && rawInstallInfo === null,
        manifestRemoved: !isScoop && manifest === null,
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

// ==========================================================================
//  状态问题（缺依赖 / 安装失败 / 清单缺失）
// ==========================================================================

/** 单个应用的状态问题，随 /api/apps 的每一项下发。 */
export interface AppIssue {
  /** 与 `scoop status` 的 "Install failed" 同义：目录在、但 install.json 不可读 */
  installFailed: boolean;
  /** 清单缺失：current/manifest.json 读不出来 */
  manifestRemoved: boolean;
  /** 缺失依赖（按应用名比对，与 Scoop 的语义一致） */
  missingDeps: string[];
}

export interface AppIssuesResult {
  /** key 为小写应用名 */
  byName: Map<string, AppIssue>;
  /** 'status' = 来自 scoop status 的权威结果；'scan' = 本地 bucket 清单比对 */
  source: 'status' | 'scan';
  /** source === 'status' 时为那次 status 的完成时间 */
  checkedAt: number | null;
}

/**
 * 汇总已安装应用的状态问题。
 *
 * 数据源优先级与 computeUpdates 一致：
 *   1) 新鲜的 `scoop status` 结果（权威）—— 它读的是**当前** bucket 清单，还联网复核；
 *   2) 本地 bucket 清单索引的 depends —— 毫秒级，不需要 PowerShell。
 *
 * 为什么不能只看 `apps/<app>/current/manifest.json`：那是安装当时的快照。
 * 依赖完全可能是后来才加到 bucket 清单里的 —— 本机 fastgithub 正是如此
 * （安装时清单里没有 depends，之后 third bucket 才加上 `depends: sudo`），
 * 只读已安装副本会永远看不到这条缺失依赖，而 `scoop status` 一眼就能看到。
 *
 * 依赖按「应用名」比对，不看命令是否存在 —— 与 Scoop 一致：系统里已经有
 * 原生的 `C:\WINDOWS\system32\sudo.exe`，`scoop status` 照样报 sudo 缺失。
 *
 * 另外，`scoop status` 只给「有情况」的应用打行（见 scoop-status.ps1 的过滤），
 * 所以有行就采信它的结论、没行才回退到本地比对 —— 两边不会互相打架。
 */
export async function computeAppIssues(apps: InstalledApp[]): Promise<AppIssuesResult> {
  await manifestIndex.ensure();
  const installedNames = new Set(apps.map((app) => app.name.toLowerCase()));
  const statusRows = getScoopStatusRows();
  const byName = new Map<string, AppIssue>();

  for (const app of apps) {
    const row = statusRows?.get(app.name.toLowerCase());

    let missingDeps = row?.missingDeps ?? [];
    if (!row) {
      const candidates = manifestIndex.find(app.name);
      const preferred =
        (app.bucket ? candidates.find((entry) => entry.bucket.toLowerCase() === app.bucket?.toLowerCase()) : undefined) ??
        candidates[0];
      // depends 允许写成 `<bucket>/<app>`，按名字比对时取末段
      missingDeps = (preferred?.depends ?? []).map((dep) => dep.split('/').pop() ?? dep);
    }

    byName.set(app.name.toLowerCase(), {
      installFailed: row ? row.info.some((item) => /install failed/i.test(item)) : app.installFailed,
      manifestRemoved: row ? row.info.some((item) => /manifest removed/i.test(item)) : app.manifestRemoved,
      missingDeps: missingDeps.filter((dep) => !installedNames.has(dep.toLowerCase())),
    });
  }

  return {
    byName,
    source: statusRows ? 'status' : 'scan',
    checkedAt: statusRows ? (getScoopStatusCache()?.cachedAt ?? null) : null,
  };
}
