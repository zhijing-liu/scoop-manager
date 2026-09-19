/**
 * Scoop 环境、系统工具、缓存与 Scoopfile 接口。
 */

import { Hono } from 'hono';
import { envelope } from '../server/errors.js';
import { assertProxyValue, safeJsonBody, toBoolean } from '../utils/validate.js';
import { APP_VERSION } from '../config.js';
import { startJob, translateResult } from '../jobs/execute.js';
import { jobManager } from '../jobs/manager.js';
import { detectScoop, clearScoopRoot, setScoopRoot } from '../services/scoop-locator.js';
import { installScoop } from '../services/scoop-installer.js';
import { invalidateScoopEnvironment } from '../services/scoop-locator.js';
import { installedApps, computeUpdates } from '../services/installed-apps.js';
import { manifestIndex } from '../services/manifest-index.js';
import { listBuckets } from '../services/bucket-service.js';
import { cacheStats, buildCacheRemoveArgs, buildCleanupArgs, exportScoopfile, prepareImportFile } from '../services/cache-service.js';
import { readConfig } from '../services/config-service.js';
import { getManagerProxy, readEffectiveProxy } from '../services/proxy-service.js';
import { assertAbsolutePath, assertName } from '../utils/validate.js';

export const scoopRoutes = new Hono();

// ------------------------------------------------------------------ 环境检测

scoopRoutes.get('/scoop/env', async (c) => {
  const env = await detectScoop();
  return c.json(envelope(env));
});

scoopRoutes.post('/scoop/env/refresh', async (c) => {
  invalidateScoopEnvironment();
  installedApps.invalidate();
  manifestIndex.invalidate();
  const env = await detectScoop(true);
  return c.json(envelope(env));
});

/** 首次进入时的引导数据：环境 + 计数 + 可更新列表 */
scoopRoutes.get('/overview', async (c) => {
  const [env, apps, buckets, cache, config, updates] = await Promise.all([
    detectScoop(),
    installedApps.list(),
    listBuckets(),
    cacheStats(),
    readConfig(),
    computeUpdates(),
  ]);

  return c.json(
    envelope({
      appVersion: APP_VERSION,
      scoop: env,
      counts: {
        installed: apps.length,
        global: apps.filter((app) => app.global).length,
        held: apps.filter((app) => app.hold).length,
        buckets: buckets.length,
        updatable: updates.items.length,
        cacheBytes: cache.totalBytes,
        indexEntries: manifestIndex.size,
      },
      updates: updates.items.slice(0, 50),
      updatesNote: updates.note,
      // 用「生效代理」而非只读 scoop config：Scoop 未安装时也要把本程序保存的值带回去
      proxy: await readEffectiveProxy(),
      configFile: config.file,
      jobs: {
        running: jobManager.runningCount(),
        recent: jobManager.list({ limit: 5 }),
      },
    }),
  );
});

// ------------------------------------------------------------------ 安装 / 定位

scoopRoutes.post('/scoop/install', async (c) => {
  const body = await safeJsonBody(c);
  const targetDir = body.targetDir === undefined || body.targetDir === null ? null : assertAbsolutePath(body.targetDir, '安装目录');
  const runAsAdmin = toBoolean(body.runAsAdmin, false);
  // 显式传入优先；否则沿用本程序保存的代理（Scoop 未安装时 scoop config 不可用）
  const proxy =
    typeof body.proxy === 'string' && body.proxy.trim().length > 0 ? assertProxyValue(body.proxy) : getManagerProxy();

  const job = startJob({
    kind: 'scoop.install',
    title: targetDir ? `安装 Scoop 到 ${targetDir}` : '安装 Scoop（默认目录）',
    target: targetDir,
    execute: async (ctx) => {
      const result = await installScoop({
        targetDir,
        runAsAdmin,
        proxy,
        jobId: ctx.jobId,
        onLine: (stream, line) => ctx.log(line, stream),
      });
      ctx.log(`Scoop 版本：${result.environment.version ?? '未知'}`);
      return { status: 'succeeded', exitCode: 0, error: null };
    },
    onSettled: () => {
      invalidateScoopEnvironment();
      installedApps.invalidate();
      manifestIndex.invalidate();
    },
  });

  return c.json(envelope({ job }), 202);
});

scoopRoutes.put('/scoop/path', async (c) => {
  const body = await safeJsonBody(c);
  const dir = assertAbsolutePath(body.dir, 'Scoop 根目录');
  const env = await setScoopRoot(dir);
  installedApps.invalidate();
  manifestIndex.invalidate();
  return c.json(envelope(env));
});

scoopRoutes.delete('/scoop/path', async (c) => {
  const env = await clearScoopRoot();
  installedApps.invalidate();
  manifestIndex.invalidate();
  return c.json(envelope(env));
});

// ------------------------------------------------------------------ 维护任务

scoopRoutes.post('/scoop/checkup', async (c) => {
  const job = startJob({
    kind: 'scoop.checkup',
    title: '环境体检（scoop checkup）',
    execute: async (ctx) => {
      const result = await ctx.scoop(['checkup'], { label: 'scoop checkup', timeoutMs: 5 * 60 * 1000 });
      return translateResult(result, '环境体检');
    },
  });
  return c.json(envelope({ job }), 202);
});

scoopRoutes.post('/scoop/self-update', async (c) => {
  const job = startJob({
    kind: 'scoop.update',
    title: '更新 Scoop 自身',
    execute: async (ctx) => {
      const result = await ctx.scoop(['update'], { label: 'scoop update', timeoutMs: 15 * 60 * 1000 });
      return translateResult(result, '更新 Scoop');
    },
    onSettled: () => {
      invalidateScoopEnvironment();
      manifestIndex.invalidate();
      installedApps.invalidate();
    },
  });
  return c.json(envelope({ job }), 202);
});

// ------------------------------------------------------------------ Scoopfile

scoopRoutes.get('/scoop/export', async (c) => {
  const includeConfig = toBoolean(c.req.query('config'), false);
  const result = await exportScoopfile({ includeConfig });
  return c.json(envelope(result));
});

scoopRoutes.post('/scoop/import', async (c) => {
  const body = await safeJsonBody(c);
  const content = typeof body.content === 'string' ? body.content : JSON.stringify(body.scoopfile ?? null);
  const prepared = await prepareImportFile(content);

  const job = startJob({
    kind: 'scoop.import',
    title: `导入 Scoopfile（${prepared.appCount} 项）`,
    execute: async (ctx) => {
      const result = await ctx.scoop(['import', prepared.file], { label: 'scoop import', timeoutMs: 60 * 60 * 1000 });
      return translateResult(result, '导入 Scoopfile');
    },
    onSettled: () => {
      installedApps.invalidate();
      manifestIndex.invalidate();
    },
  });
  return c.json(envelope({ job }), 202);
});

// ------------------------------------------------------------------ 缓存

scoopRoutes.get('/cache', async (c) => {
  const stats = await cacheStats();
  return c.json(envelope(stats));
});

scoopRoutes.post('/cache/remove', async (c) => {
  const body = await safeJsonBody(c);
  const target = body.target === undefined || body.target === null ? null : assertName(body.target, '缓存条目名称');
  const job = startJob({
    kind: 'cache.remove',
    title: target ? `清理缓存 ${target}` : '清空全部下载缓存',
    target,
    execute: async (ctx) => {
      const result = await ctx.scoop(buildCacheRemoveArgs(target), { label: 'scoop cache rm', timeoutMs: 10 * 60 * 1000 });
      return translateResult(result, '清理缓存');
    },
  });
  return c.json(envelope({ job }), 202);
});

scoopRoutes.post('/cache/cleanup', async (c) => {
  const body = await safeJsonBody(c);
  const apps = Array.isArray(body.apps) ? (body.apps as unknown[]).map((item) => assertName(item, '应用名称')) : [];
  const job = startJob({
    kind: 'app.cleanup',
    title: apps.length > 0 ? `清理旧版本：${apps.join(', ')}` : '清理全部应用的旧版本',
    execute: async (ctx) => {
      const result = await ctx.scoop(buildCleanupArgs(apps), { label: 'scoop cleanup', timeoutMs: 15 * 60 * 1000 });
      return translateResult(result, '清理旧版本');
    },
    onSettled: () => installedApps.invalidate(),
  });
  return c.json(envelope({ job }), 202);
});
