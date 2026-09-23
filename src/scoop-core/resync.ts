/**
 * 一次性作废所有进程内缓存。
 *
 * 存在的原因：本程序大量使用「目录快照 / 时间 TTL」避免重复扫盘，而用户在终端里
 * 直接用 scoop 操作（install / uninstall / update / hold / bucket add / config set …）
 * 时，那些缓存不会收到任何通知。多数情况下快照能在几秒内自动发现目录变化，
 * 但有两类一定不会自愈：
 *   - `scoop hold`：只改 apps/<name>/current/install.json 的内容，父目录 mtime 不变，
 *     目录级快照捕捉不到；
 *   - `scoop status` 结果缓存（5 分钟 TTL）：必须显式作废。
 * 因此提供这个"一键重新同步"，让用户不必重启服务、也不必挨个页面找按钮。
 *
 * 注意：这里只清缓存、不跑命令。真正的联网权威结果（scoop status）由调用方
 * 在后台用 refreshScoopStatusCache() 补一次（见 routes/health.ts 的 /system/resync）。
 */

import { invalidateScoopEnvironment } from './locator.js';
import { clearScoopStatusCache, installedApps } from './installed.js';
import { manifestIndex } from './manifest.js';
import { invalidateKnownBuckets } from './bucket.js';
import { invalidatePowerShellCache } from './powershell.js';

/** 被清掉的缓存项（返回给调用方展示 / 排障） */
export const CACHE_NAMES = [
  'scoop-env', // Scoop 根目录 / 版本 / PowerShell 探测结果
  'powershell', // PowerShell 路径探测（含"未找到"这种负结果）
  'installed-apps', // 已安装应用快照
  'manifest-index', // bucket manifest 索引
  'scoop-status', // scoop status 的可更新列表结果
  'known-buckets', // scoop bucket known 列表
] as const;

export function invalidateAllCaches(): string[] {
  invalidateScoopEnvironment();
  invalidatePowerShellCache();
  installedApps.invalidate();
  manifestIndex.invalidate();
  clearScoopStatusCache();
  invalidateKnownBuckets();
  return [...CACHE_NAMES];
}
