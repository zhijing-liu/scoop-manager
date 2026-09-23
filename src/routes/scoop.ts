/**
 * Scoop 环境、系统工具、缓存与 Scoopfile 接口。
 */

import { Hono } from 'hono';
import { AppError, envelope } from '../server/errors.js';
import { assertProxyValue, safeJsonBody, toBoolean } from '../utils/validate.js';
import { APP_VERSION } from '../config.js';
import { startJob, translateResult } from '../jobs/execute.js';
import { jobManager } from '../jobs/manager.js';
import { detectScoop, clearScoopRoot, setScoopRoot } from '../scoop-core/locator.js';
import { installScoop } from '../scoop-core/installer.js';
import { invalidateScoopEnvironment } from '../scoop-core/locator.js';
import { installedApps, computeUpdates } from '../scoop-core/installed.js';
import { manifestIndex } from '../scoop-core/manifest.js';
import { listBuckets } from '../scoop-core/bucket.js';
import { cacheStats, buildCacheRemoveArgs, exportScoopfile, prepareImportFile, removeImportFile } from '../scoop-core/cache.js';
import { readConfig } from '../scoop-core/config.js';
import { getManagerProxy, readEffectiveProxy } from '../scoop-core/proxy.js';
import { assertAbsolutePath, assertName, toNameList } from '../utils/validate.js';
import { CLEANUP, DOWNLOAD, HOLD, INSTALL, UPDATE, buildFlags, listCommandDefs } from '../scoop-core/options.js';
import { assertArchitecture } from '../utils/validate.js';

export const scoopRoutes = new Hono();

/** 导入接口的请求体上限（字符数），见 /scoop/import 的注释 */
const MAX_IMPORT_CHARS = 4 * 1024 * 1024;

// ------------------------------------------------------------------ 参数定义（单一数据源，供前端渲染语义化选项面板）

scoopRoutes.get('/scoop/options', (c) => {
  // 前端只会消费这一组核心命令；注册表里全量暴露便于未来扩展
  const coreKeys = ['install', 'update', 'uninstall', 'hold', 'unhold', 'cleanup', 'reset', 'cache-rm'];
  return c.json(envelope(listCommandDefs().filter((c) => coreKeys.includes(c.key))));
});

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
  const force = toBoolean(c.req.query('force'), false);
  const [env, apps, buckets, cache, config, updates] = await Promise.all([
    detectScoop(),
    installedApps.list(force),
    listBuckets(),
    cacheStats(),
    readConfig(),
    computeUpdates(force),
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
      // 来源标注：前端据此显示「权威（联网）/ 本地索引」徽标，
      // 并在「重新同步」后轮询等待后台 scoop status 回填
      updatesSource: updates.source,
      updatesCachedAt: updates.cachedAt,
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
    request: { method: 'POST', path: '/api/scoop/checkup', body: {} },
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
    request: { method: 'POST', path: '/api/scoop/self-update', body: {} },
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
  // 请求体本身没有全局上限（Hono 默认不限），这里给导入单独兜一道：
  // 正常备份只有几十 KB，超过这个量级基本可以判定是误选文件或恶意构造
  if (content.length > MAX_IMPORT_CHARS) {
    throw new AppError('INVALID_PARAM', `Scoopfile 过大（上限 ${Math.round(MAX_IMPORT_CHARS / (1024 * 1024))} MB）。`);
  }
  const prepared = await prepareImportFile(content);

  const job = startJob({
    kind: 'scoop.import',
    title: `导入 Scoopfile（${prepared.appCount} 项）`,
    execute: async (ctx) => {
      try {
        const result = await ctx.scoop(['import', prepared.file], { label: 'scoop import', timeoutMs: 60 * 60 * 1000 });
        return translateResult(result, '导入 Scoopfile');
      } finally {
        // 每个请求一份独立临时文件，用完即删，避免数据目录里越积越多
        removeImportFile(prepared.file);
      }
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
    request: { method: 'POST', path: '/api/cache/remove', body },
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
  const options: Record<string, unknown> = {
    global: toBoolean(body.global, false),
    cache: toBoolean(body.cache, false),
  };
  const args = ['cleanup', ...buildFlags(CLEANUP, options), ...(apps.length > 0 ? apps : ['*']) as string[]];
  const job = startJob({
    kind: 'app.cleanup',
    title:
      apps.length > 0
        ? `清理旧版本：${apps.join(', ')}${options.cache ? '（含过期缓存）' : ''}`
        : `清理全部旧版本${options.cache ? '（含过期缓存）' : ''}`,
    // 清空 body 里带了 cache / global，从 target 反推会丢（甚至会退化成"清理全部应用"）
    request: { method: 'POST', path: '/api/cache/cleanup', body },
    execute: async (ctx) => {
      const result = await ctx.scoop(args, { label: 'scoop cleanup', timeoutMs: 15 * 60 * 1000 });
      return translateResult(result, '清理旧版本');
    },
    onSettled: () => installedApps.invalidate(),
  });
  return c.json(envelope({ job }), 202);
});

// ------------------------------------------------------------------ scoop 自身卸载 + download（P3：补充值得覆盖但之前没有的命令）

scoopRoutes.post('/scoop/uninstall', async (c) => {
  const env = await detectScoop(true);
  if (!env.installed) {
    return c.json(envelope({ job: null, skipped: true, reason: 'Scoop 尚未安装，无需卸载。' }));
  }
  const body = await safeJsonBody(c);
  const purge = toBoolean(body.purge, false);
  const globalInstall = toBoolean(body.global, false);

  const args = ['uninstall'];
  if (globalInstall) args.push('-g');
  if (purge) args.push('-p');
  args.push('scoop');

  const job = startJob({
    kind: 'scoop.install' as never,
    title: `卸载 Scoop${purge ? '（彻底清理）' : ''}`,
    target: 'scoop',
    execute: async (ctx) =>
      translateResult(await ctx.scoop(args, { label: 'scoop uninstall scoop', timeoutMs: 15 * 60 * 1000 }), '卸载 Scoop'),
    onSettled: () => {
      invalidateScoopEnvironment();
      installedApps.invalidate();
      manifestIndex.invalidate();
    },
  });
  return c.json(envelope({ job }), 202);
});

scoopRoutes.post('/apps/download', async (c) => {
  const body = await safeJsonBody(c);
  const apps = toNameList(body.apps, '应用名称');
  const options: Record<string, unknown> = {
    force: toBoolean(body.force, false),
    noUpdateScoop: toBoolean(body.noUpdateScoop, false),
    skipHash: toBoolean(body.skipHash, false),
    arch: body.arch === undefined || body.arch === null || body.arch === '' ? null : assertArchitecture(body.arch),
  };

  // scoop download 官方 getopt：'fsua:'  —— 与 install 的 'giksua:' 不同！
  // 尤其注意：install 用 -k 表示"不用缓存"；download 用 -f 表示"强制覆盖缓存"（语义相反）
  const args = ['download', ...buildFlags(DOWNLOAD, options), ...apps];

  const job = startJob({
    kind: 'app.install' as never,
    title: `仅下载（不安装）：${apps.join(', ')}`,
    target: apps.join(', '),
    execute: async (ctx) => {
      ctx.log(`执行：scoop ${args.join(' ')}`);
      return translateResult(await ctx.scoop(args, { label: 'scoop download', timeoutMs: 30 * 60 * 1000 }), '下载');
    },
  });
  return c.json(envelope({ job }), 202);
});
