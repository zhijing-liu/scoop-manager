/**
 * 应用搜索与应用仓库详情（基于本地 bucket manifest 索引）。
 */

import { Hono } from 'hono';
import { envelope } from '../server/errors.js';
import { assertName, toInteger } from '../utils/validate.js';
import { manifestIndex, type ManifestEntry } from '../scoop-core/manifest.js';
import { bucketNamesCached } from '../scoop-core/bucket-internal.js';

export const searchRoutes = new Hono();

searchRoutes.get('/search', async (c) => {
  await manifestIndex.ensure();
  const query = c.req.query('q') ?? '';
  const bucket = c.req.query('bucket') ?? null;
  const limit = toInteger(c.req.query('limit'), 60, 1, 200);
  const offset = toInteger(c.req.query('offset'), 0, 0, 100000);

  const result = manifestIndex.search(query, { bucket, limit, offset });
  return c.json(
    envelope({
      ...result,
      index: manifestIndex.stats(),
      buckets: bucketNamesCached(),
    }),
  );
});

searchRoutes.get('/search/index', async (c) => {
  await manifestIndex.ensure();
  return c.json(envelope(manifestIndex.stats()));
});

searchRoutes.post('/search/index/refresh', async (c) => {
  manifestIndex.invalidate();
  await manifestIndex.ensure(true);
  return c.json(envelope(manifestIndex.stats()));
});

export interface DependencyNode {
  name: string;
  version: string | null;
  bucket: string | null;
  /** 是否已安装 */
  installed: boolean;
  /** 解析不到的依赖（可能来自未添加的 bucket） */
  missing: boolean;
}

/**
 * 依赖解析。
 *
 * 完全基于本地索引做递归展开，不调用 `scoop depends`（同样是为了避开
 * PowerShell 冷启动与文本解析），并做了环路保护与深度限制。
 */
export function resolveDependencies(name: string, installedNames: Set<string>, maxDepth = 5): DependencyNode[] {
  const result: DependencyNode[] = [];
  const visited = new Set<string>([name.toLowerCase()]);

  const walk = (target: string, depth: number): void => {
    if (depth > maxDepth) return;
    const entries = manifestIndex.find(target);
    const entry: ManifestEntry | undefined = entries[0];
    if (!entry) {
      result.push({ name: target, version: null, bucket: null, installed: installedNames.has(target.toLowerCase()), missing: true });
      return;
    }
    for (const dependency of entry.depends) {
      const key = dependency.toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);
      const dependencyEntries = manifestIndex.find(dependency);
      const dependencyEntry = dependencyEntries[0];
      result.push({
        name: dependency,
        version: dependencyEntry?.version ?? null,
        bucket: dependencyEntry?.bucket ?? null,
        installed: installedNames.has(key),
        missing: !dependencyEntry,
      });
      walk(dependency, depth + 1);
    }
  };

  walk(name, 1);
  return result;
}

searchRoutes.get('/search/app/:name', async (c) => {
  const name = assertName(c.req.param('name'), '应用名称');
  await manifestIndex.ensure();

  const entries = manifestIndex.find(name);
  if (entries.length === 0) {
    return c.json(envelope({ name, found: false, entries: [], dependencies: [] }));
  }

  const { installedApps } = await import('../scoop-core/installed.js');
  const installedNames = new Set((await installedApps.list()).map((app) => app.name.toLowerCase()));

  return c.json(
    envelope({
      name,
      found: true,
      entries,
      dependencies: resolveDependencies(name, installedNames),
      installed: installedNames.has(name.toLowerCase()),
    }),
  );
});
