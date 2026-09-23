/**
 * 已安装应用接口：列表、详情、安装、卸载、更新、锁定、重置。
 *
 * 所有命令参数都通过共享的 scoop-options 注册表生成 flags，
 * 避免分散硬编码导致短选项错误（参考 scoop-options.ts 顶部注释的 P0 bug）。
 */

import { Hono } from 'hono';
import { AppError, envelope } from '../server/errors.js';
import {
  assertArchitecture,
  assertName,
  safeJsonBody,
  toBoolean,
  toNameList,
} from '../utils/validate.js';
import { startJob, translateResult } from '../jobs/execute.js';
import {
  computeUpdates,
  installedApps,
  readManifestRaw,
  refreshScoopStatusCache,
  setScoopStatusCache,
} from '../scoop-core/installed.js';
import { manifestIndex } from '../scoop-core/manifest.js';
import { buildFlags, HOLD, INSTALL, RESET, UNINSTALL, UPDATE } from '../scoop-core/options.js';
import type { JobKind } from '../jobs/types.js';

export const appRoutes = new Hono();

const LONG = 30 * 60 * 1000;

// ------------------------------------------------------------------ 查询（具体路径优先）

appRoutes.get('/apps', async (c) => {
  const force = toBoolean(c.req.query('force'), false);
  const items = await installedApps.list(force);
  return c.json(envelope({ items }));
});

appRoutes.get('/apps/updates', async (c) => {
  const force = toBoolean(c.req.query('force'), false);
  const summary = await computeUpdates(force);
  return c.json(envelope(summary));
});

appRoutes.post('/apps/status', (c) => {
  const job = startJob({
    kind: 'app.status',
    title: '检查应用更新状态（scoop status）',
    // 原始请求快照：前端「一键重试」原样重放，不需要再从 target 反推参数
    request: { method: 'POST', path: '/api/apps/status', body: {} },
    execute: async (ctx) => {
      const result = await ctx.scoop(['status'], {
        label: 'scoop status',
        serial: false,
        timeoutMs: 15 * 60 * 1000,
      });
      if (result.code === 0 && !result.canceled && !result.timedOut && result.stdout) {
        setScoopStatusCache(result.stdout);
      }
      return translateResult(result, '检查更新状态');
    },
    onSettled: ({ status }) => {
      if (status === 'succeeded') installedApps.invalidate();
    },
  });
  return c.json(envelope({ job }), 202);
});

/**
 * 直接执行 `scoop list`，把 Scoop 自己输出的清单原样打到任务日志。
 *
 * 存在的意义：界面上的清单是本程序扫 apps 目录得来的（更快、字段更多），
 * 一旦两者对不上（在终端里操作过、目录结构与预期不符），需要一个
 * "看上游原始输出"的入口来定位到底是哪一边不对。
 *
 * 只读命令，不进串行队列；输出由 runner 按行实时写入任务日志。
 */
appRoutes.post('/apps/list', async (c) => {
  const body = await safeJsonBody(c);
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (query.length > 100) throw new AppError('INVALID_PARAM', '筛选词过长（上限 100 字符）。');
  if (/[\u0000-\u001f\u007f]/.test(query)) throw new AppError('INVALID_PARAM', '筛选词包含控制字符。');

  const job = startJob({
    kind: 'app.list',
    title: query ? `列出已安装应用（scoop list ${query}）` : '列出已安装应用（scoop list）',
    request: { method: 'POST', path: '/api/apps/list', body },
    execute: async (ctx) =>
      translateResult(
        await ctx.scoop(['list', ...(query ? [query] : [])], {
          label: 'scoop list',
          serial: false,
          timeoutMs: 2 * 60 * 1000,
        }),
        '列出已安装应用',
      ),
  });
  return c.json(envelope({ job }), 202);
});

appRoutes.get('/apps/:name', async (c) => {
  const name = assertName(c.req.param('name'), '应用名称');
  await manifestIndex.ensure();
  const app = await installedApps.get(name);
  const raw = app ? await readManifestRaw(app.path) : null;
  return c.json(
    envelope({
      installed: app,
      manifest: raw,
      available: manifestIndex.find(name),
    }),
  );
});

// ------------------------------------------------------------------ 变更操作

appRoutes.post('/apps/install', async (c) => {
  const body = await safeJsonBody(c);
  const apps = toNameList(body.apps, '应用名称').filter((name) => name !== '*');

  const options: Record<string, unknown> = {
    global: toBoolean(body.global, false),
    independent: toBoolean(body.independent, false),
    skipHash: toBoolean(body.skipHash, false),
    noCache: toBoolean(body.noCache, false),
    noUpdateScoop: toBoolean(body.noUpdateScoop, false),
    arch: body.arch === undefined || body.arch === null || body.arch === '' ? null : assertArchitecture(body.arch),
  };

  const args = ['install', ...buildFlags(INSTALL, options), ...apps];

  const job = startJob({
    kind: 'app.install',
    title: `${options.global ? '全局安装' : '安装'}：${apps.join(', ')}`,
    target: apps.join(', '),
    request: { method: 'POST', path: '/api/apps/install', body },
    execute: async (ctx) => {
      ctx.log(`执行：scoop ${args.join(' ')}`);
      if (options.global) ctx.log('全局安装需要管理员权限，若失败请以管理员身份重新启动本程序。');
      return translateResult(
        await ctx.scoop(args, { label: `scoop install ${apps.join(' ')}`, timeoutMs: LONG }),
        '安装',
      );
    },
    onSettled: () => {
      installedApps.invalidate();
      manifestIndex.invalidate();
    },
  });

  return c.json(envelope({ job }), 202);
});

appRoutes.post('/apps/uninstall', async (c) => {
  const body = await safeJsonBody(c);
  const apps = toNameList(body.apps, '应用名称').filter((name) => name !== '*');

  const options: Record<string, unknown> = {
    global: toBoolean(body.global, false),
    purge: toBoolean(body.purge, false),
  };
  const args = ['uninstall', ...buildFlags(UNINSTALL, options), ...apps];

  const job = startJob({
    kind: 'app.uninstall',
    title: `卸载：${apps.join(', ')}${options.purge ? '（彻底清理）' : ''}`,
    target: apps.join(', '),
    request: { method: 'POST', path: '/api/apps/uninstall', body },
    execute: async (ctx) =>
      translateResult(
        await ctx.scoop(args, { label: `scoop uninstall ${apps.join(' ')}`, timeoutMs: 15 * 60 * 1000 }),
        '卸载',
      ),
    onSettled: () => installedApps.invalidate(),
  });

  return c.json(envelope({ job }), 202);
});

appRoutes.post('/apps/update', async (c) => {
  const body = await safeJsonBody(c);
  const all = toBoolean(body.all, false);
  // 未显式指定 all 时，apps 必填
  const apps = all ? ['*'] : toNameList(body.apps, '应用名称');

  const options: Record<string, unknown> = {
    global: toBoolean(body.global, false),
    force: toBoolean(body.force, false),
    independent: toBoolean(body.independent, false),
    noCache: toBoolean(body.noCache, false),
    skipHash: toBoolean(body.skipHash, false),
    quiet: toBoolean(body.quiet, false),
  };
  const args = ['update', ...buildFlags(UPDATE, options), ...apps];

  const job = startJob({
    kind: 'app.update',
    title: all ? '更新全部应用' : `更新：${apps.join(', ')}`,
    target: all ? '*' : apps.join(', '),
    request: { method: 'POST', path: '/api/apps/update', body },
    execute: async (ctx) => {
      if (all) ctx.log('更新全部应用可能耗时较长，请保持本页面打开。');
      return translateResult(
        await ctx.scoop(args, {
          label: `scoop update ${apps.join(' ')}`,
          timeoutMs: 60 * 60 * 1000,
        }),
        '更新',
      );
    },
    onSettled: ({ status }) => {
      installedApps.invalidate();
      manifestIndex.invalidate();
      // 更新成功后 bucket/本地版本可能已变化，后台刷新 scoop status 权威缓存
      if (status === 'succeeded') void refreshScoopStatusCache();
    },
  });

  return c.json(envelope({ job }), 202);
});

appRoutes.post('/apps/hold', async (c) => {
  const body = await safeJsonBody(c);
  const apps = toNameList(body.apps, '应用名称').filter((name) => name !== '*');
  const hold = toBoolean(body.hold, true);
  const global = toBoolean(body.global, false);

  const args = [hold ? 'hold' : 'unhold', ...buildFlags(HOLD, { global }), ...apps];

  const job = startJob({
    kind: (hold ? 'app.hold' : 'app.unhold') as JobKind,
    title: `${hold ? '锁定' : '解除锁定'}：${apps.join(', ')}`,
    target: apps.join(', '),
    execute: async (ctx) =>
      translateResult(
        await ctx.scoop(args, {
          label: `scoop ${hold ? 'hold' : 'unhold'}`,
          timeoutMs: 5 * 60 * 1000,
        }),
        hold ? '锁定' : '解除锁定',
      ),
    onSettled: () => installedApps.invalidate(),
  });

  return c.json(envelope({ job }), 202);
});

appRoutes.post('/apps/reset', async (c) => {
  const body = await safeJsonBody(c);
  const apps = toNameList(body.apps, '应用名称');
  const args = ['reset', ...apps];

  const job = startJob({
    kind: 'app.reset',
    title: `重置应用：${apps.join(', ')}`,
    target: apps.join(', '),
    request: { method: 'POST', path: '/api/apps/reset', body },
    execute: async (ctx) =>
      translateResult(
        await ctx.scoop(args, { label: 'scoop reset', timeoutMs: 15 * 60 * 1000 }),
        '重置',
      ),
    onSettled: () => installedApps.invalidate(),
  });

  return c.json(envelope({ job }), 202);
});

// 说明：`scoop cleanup` 的唯一入口是 POST /api/cache/cleanup（见 routes/scoop.ts）。
// 这里曾有一份逐行相同的 POST /apps/cleanup 副本，已删除以避免两套实现各自漂移。
