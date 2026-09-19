/**
 * bucket 名列表的轻量缓存。
 *
 * 单独抽出这一层是为了避免 route -> service 之间的循环依赖：
 * search 路由只需要"当前有哪些 bucket"，不需要触发完整索引构建。
 */

import { join } from 'node:path';
import { listDirs } from '../utils/fsx.js';
import { getCachedScoopEnvironment } from './scoop-locator.js';

export function bucketNamesCached(): string[] {
  const env = getCachedScoopEnvironment();
  if (!env?.root) return [];
  return listDirs(join(env.root, 'buckets')).sort((a, b) => a.localeCompare(b));
}
