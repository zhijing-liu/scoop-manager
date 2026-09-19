/**
 * Bucket 管理。
 *
 * 列举走文件系统（快、稳），known 列表走 `scoop bucket known`（这是 Scoop 内置的
 * 静态列表，输出就是一行一个名字，解析风险极低），增删改走任务系统。
 */

import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { exists, listDirs, readText, statSafe } from '../utils/fsx.js';
import { detectScoop, requireScoopEnvironment } from './scoop-locator.js';
import { psQuote, runPowerShellOnce } from './powershell.js';
import { readConfig } from './config-service.js';
import { manifestIndex } from './manifest-index.js';
import { assertName } from '../utils/validate.js';
import { AppError } from '../server/errors.js';

const logger = createLogger('bucket');

/** Scoop 官方维护的核心 bucket */
const OFFICIAL_BUCKETS = new Set(['main', 'extras', 'versions', 'nirsoft', 'php', 'nerd-fonts', 'nonportable', 'java', 'games']);

/** 离线兜底：无法执行 PowerShell 时至少能给出建议列表 */
const FALLBACK_KNOWN = ['main', 'extras', 'versions', 'nirsoft', 'php', 'nerd-fonts', 'nonportable', 'java', 'games'];

export interface BucketInfo {
  name: string;
  /** git 远端地址，例如 https://github.com/ScoopInstaller/Main */
  source: string | null;
  manifestCount: number;
  /** 最近一次更新（以 bucket/ 目录 mtime 估算） */
  updatedAt: number | null;
  official: boolean;
  path: string;
}

/** 从 .git/config 中解析 origin 远端地址。 */
function readGitSource(bucketPath: string): string | null {
  const configText = readText(join(bucketPath, '.git', 'config'));
  if (!configText) return null;
  const lines = configText.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(trimmed);
      continue;
    }
    if (inOrigin && trimmed.toLowerCase().startsWith('url')) {
      const value = trimmed.slice(trimmed.indexOf('=') + 1).trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

export async function listBuckets(): Promise<BucketInfo[]> {
  const env = await detectScoop();
  if (!env.installed || !env.root) return [];

  const bucketsDir = join(env.root, 'buckets');
  if (!exists(bucketsDir)) return [];

  // 索引里的统计信息更准确（排除 _bucket.json 等元数据文件）
  if (!manifestIndex.isBuilding && manifestIndex.size === 0) {
    await manifestIndex.ensure();
  }
  const counts = manifestIndex.countByBucket();

  return listDirs(bucketsDir)
    .map((name) => {
      const path = join(bucketsDir, name);
      return {
        name,
        source: readGitSource(path),
        manifestCount: counts[name] ?? 0,
        updatedAt: statSafe(join(path, 'bucket'))?.mtimeMs ?? null,
        official: OFFICIAL_BUCKETS.has(name.toLowerCase()),
        path,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

let knownCache: { at: number; items: string[] } | null = null;

/** 已知 bucket 列表（Scoop 内置的推荐列表）。 */
export async function knownBuckets(): Promise<{ items: Array<{ name: string; added: boolean; official: boolean }>; source: 'scoop' | 'fallback' }> {
  const env = await detectScoop();
  const installed = new Set(listBuckets0(env.root));

  let names: string[] = [];
  let source: 'scoop' | 'fallback' = 'fallback';

  if (env.installed && env.powershell.path) {
    if (knownCache && Date.now() - knownCache.at < 5 * 60 * 1000) {
      names = knownCache.items;
      source = 'scoop';
    } else {
      try {
        const result = await runPowerShellOnce('scoop bucket known', 20000);
        const parsed = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^[A-Za-z0-9._-]+$/.test(line));
        if (parsed.length > 0) {
          names = parsed;
          source = 'scoop';
          knownCache = { at: Date.now(), items: parsed };
        }
      } catch (error) {
        logger.warn(`获取 known bucket 失败，使用内置列表: ${(error as Error).message}`);
      }
    }
  }

  if (names.length === 0) names = FALLBACK_KNOWN;

  return {
    items: names.map((name) => ({ name, added: installed.has(name.toLowerCase()), official: OFFICIAL_BUCKETS.has(name.toLowerCase()) })),
    source,
  };
}

/** 同步版本的已安装 bucket 名（内部使用，避免递归 await） */
function listBuckets0(root: string | null): string[] {
  if (!root) return [];
  return listDirs(join(root, 'buckets'));
}

/** 校验并构造 `bucket add` 的参数。 */
export function buildAddArgs(name: string, repoUrl?: string | null): string[] {
  const safeName = assertName(name, 'Bucket 名称');
  if (repoUrl && repoUrl.trim().length > 0) {
    const url = repoUrl.trim();
    // 允许常见 git 远端写法：https / ssh / git@host:path
    if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)[^\s"'`]+$/i.test(url)) {
      throw new AppError('INVALID_PARAM', '仓库地址格式不合法，应以 https:// 、git@ 或 ssh:// 开头。');
    }
    return ['bucket', 'add', safeName, url];
  }
  return ['bucket', 'add', safeName];
}

export function buildRemoveArgs(name: string): string[] {
  return ['bucket', 'rm', assertName(name, 'Bucket 名称')];
}

export interface BucketSyncPlan {
  /** 参与同步的 bucket 名（均为 git 仓库） */
  buckets: string[];
  /** 被跳过的 bucket 名（不是 git 仓库，无法用 git pull 同步） */
  skipped: string[];
  /** 是否把 scoop 配置的代理透传给了 git */
  viaProxy: boolean;
  /** 交由 runner 以 script 方式执行的 PowerShell 脚本（内部值均已 psQuote 转义） */
  script: string;
}

/**
 * 生成「同步 bucket」的执行计划。
 *
 * ⚠️ Scoop **没有** `scoop bucket update` 子命令：libexec/scoop-bucket.ps1 只支持
 * add / list / known / rm，传入 update 会走 default 分支，输出
 * 「scoop bucket: cmd 'update' not supported」并 exit 1（实测确认）。
 *
 * Scoop 自身同步 bucket 的方式是 libexec/scoop-update.ps1 里的 Sync-Bucket：
 * 对每个「是 git 仓库」的 bucket 执行 `git pull`。这里采用完全相同的机制，
 * 从而同时覆盖「更新单个」与「更新全部」，并且不会顺带更新 Scoop 自身
 * （那是「更新 Scoop 自身」按钮的职责）。
 *
 * 非 git 仓库的 bucket 会被跳过：Scoop 对这种情况的处理是提示后跳过
 * （Sync-Bucket 里的 "is not a git repository. Skipped."），此处保持一致。
 */
export async function buildBucketSyncPlan(name?: string | null): Promise<BucketSyncPlan> {
  const env = await requireScoopEnvironment();
  const requested = name ? [assertName(name, 'Bucket 名称')] : listDirs(join(env.root, 'buckets'));

  const all = requested.map((bucket) => ({ name: bucket, path: join(env.root, 'buckets', bucket) }));

  if (name && !exists(all[0]?.path ?? '')) {
    throw new AppError('NOT_FOUND', `Bucket「${name}」不存在。`);
  }

  const buckets = all.filter((item) => exists(join(item.path, '.git')));
  const skipped = all.filter((item) => !buckets.includes(item)).map((item) => item.name);

  if (buckets.length === 0) {
    throw new AppError(
      'COMMAND_FAILED',
      name
        ? `Bucket「${name}」不是 git 仓库，无法单独同步（该 bucket 可能是以解压方式添加的）。请改用「更新 Scoop 自身」。`
        : '没有可同步的 Bucket（当前所有 bucket 都不是 git 仓库）。',
    );
  }

  // git 不读 scoop 的代理配置，这里把它转成 git 的 -c http.proxy 透传过去，
  // 否则「scoop 下载走了代理、bucket 同步却直连」会出现两套行为。
  const proxy = gitProxyFromScoopValue((await readConfig()).proxy.value);

  const proxyArgs = proxy ? ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`] : [];

  // 逐个 git pull；任一失败最终退出码非 0，job 据此判定失败
  const lines = ['$failed = 0'];
  for (const item of buckets) {
    lines.push(`& git ${proxyArgs.join(' ')} -C ${psQuote(item.path)} pull`.trim());
    lines.push('if ($LASTEXITCODE -ne 0) { $failed = 1 }');
  }
  lines.push('exit $failed');

  return {
    buckets: buckets.map((item) => item.name),
    skipped,
    script: lines.join('\n'),
    viaProxy: proxy !== null,
  };
}

/**
 * 把 scoop 的代理值转换成 git 可用的 http.proxy 形式。
 *
 * scoop 接受 `host:port` / `http(s)://[user:pass@]host:port` / current / none；
 * git 的 `-c http.proxy` 需要带协议，因此裸 `host:port` 会补上 `http://`。
 * `current`（跟随系统）与 `none` 对 git 而言无法表达，返回 null 表示不透传。
 */
function gitProxyFromScoopValue(value: string | null): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw || /^(current|none)$/i.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  return /^https?:\/\/[^\s@/]+(:[^\s@/]+)?@?[^\s@/]+(:\d+)?$/i.test(withScheme) ? withScheme : null;
}

export async function currentBucketNames(): Promise<string[]> {
  const env = await requireScoopEnvironment();
  return listDirs(join(env.root, 'buckets'));
}
