/**
 * 已安装应用接口：列表、详情、安装、卸载、更新、锁定、重置。
 */

import { Hono } from 'hono';
import { envelope } from '../server/errors.js';
import { assertArchitecture, assertName, safeJsonBody, toBoolean, toNameList } from '../utils/validate.js';
import { startJob, translateResult } from '../jobs/execute.js';
import { computeUpdates, installedApps, readManifestRaw } from '../services/installed-apps.js';
import { manifestIndex } from '../services/manifest-index.js';
import type { JobKind } from '../jobs/types.js';

export const appRoutes = new Hono();

const LONG = 30 * 60 * 1000;

function buildInstallArgs(
  apps: string[],
  options: { global: boolean; independent: boolean; skipHash: boolean; noCache: boolean; arch: string | null },
): string[] {
  const flags: string[] = [];
  if (options.global) flags.push('-g');
  if (options.independent) flags.push('-i');
  if (options.skipHash) flags.push('-s');
  if (options.noCache) flags.push('-n');
  if (options.arch) flags.push('-a', options.arch);
  return ['install', ...flags, ...apps];
}

// ------------------------------------------------------------------ 查询（具体路径优先）

appRoutes.get('/apps', async (c) => {
  const items = await installedApps.list();
  return c.json(envelope({ items }));
});

appRoutes.get('/apps/updates', async (c) => {
  const summary = await computeUpdates();
  return c.json(envelope(summary));
});

appRoutes.post('/apps/status', (c) => {
  const job = startJob({
    kind: 'scoop.checkup',
    title: '检查应用更新状态（scoop status）',
    execute: async (ctx) => translateResult(await ctx.scoop(['status'], { label: 'scoop status', serial: false, timeoutMs: 15 * 60 * 1000 }), '检查更新状态'),
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
  const global = toBoolean(body.global, false);
  const independent = toBoolean(body.independent, false);
  const skipHash = toBoolean(body.skipHash, false);
  const noCache = toBoolean(body.noCache, false);
  const arch = body.arch === undefined || body.arch === null || body.arch === '' ? null : assertArchitecture(body.arch);

  const args = buildInstallArgs(apps, { global, independent, skipHash, noCache, arch });

  const job = startJob({
    kind: 'app.install',
    title: `${global ? '全局安装' : '安装'}：${apps.join(', ')}`,
    target: apps.join(', '),
    execute: async (ctx) => {
      ctx.log(`执行：scoop ${args.join(' ')}`);
      if (global) ctx.log('全局安装需要管理员权限，若失败请以管理员身份重新启动本程序。');
      return translateResult(await ctx.scoop(args, { label: `scoop install ${apps.join(' ')}`, timeoutMs: LONG }), '安装');
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
  const global = toBoolean(body.global, false);
  const purge = toBoolean(body.purge, false);

  const flags: string[] = [];
  if (global) flags.push('-g');
  if (purge) flags.push('-p');
  const args = ['uninstall', ...flags, ...apps];

  const job = startJob({
    kind: 'app.uninstall',
    title: `卸载：${apps.join(', ')}${purge ? '（彻底清理）' : ''}`,
    target: apps.join(', '),
    execute: async (ctx) => translateResult(await ctx.scoop(args, { label: `scoop uninstall ${apps.join(' ')}`, timeoutMs: 15 * 60 * 1000 }), '卸载'),
    onSettled: () => {
      installedApps.invalidate();
    },
  });

  return c.json(envelope({ job }), 202);
});

appRoutes.post('/apps/update', async (c) => {
  const body = await safeJsonBody(c);
  const all = toBoolean(body.all, false);
  const force = toBoolean(body.force, false);
  const global = toBoolean(body.global, false);

  // 未显式指定 all 时，apps 必填
  const apps = all ? ['*'] : toNameList(body.apps, '应用名称');
  const flags: string[] = [];
  if (force) flags.push('-f');
  if (global) flags.push('-g');
  const args = ['update', ...flags, ...apps];

  const job = startJob({
    kind: 'app.update',
    title: all ? '更新全部应用' : `更新：${apps.join(', ')}`,
    target: all ? '*' : apps.join(', '),
    execute: async (ctx) => {
      if (all) ctx.log('更新全部应用可能耗时较长，请保持本页面打开。');
      return translateResult(await ctx.scoop(args, { label: `scoop update ${apps.join(' ')}`, timeoutMs: 60 * 60 * 1000 }), '更新');
    },
    onSettled: () => {
      installedApps.invalidate();
      manifestIndex.invalidate();
    },
  });

  return c.json(envelope({ job }), 202);
});

appRoutes.post('/apps/hold', async (c) => {
  const body = await safeJsonBody(c);
  const apps = toNameList(body.apps, '应用名称').filter((name) => name !== '*');
  const hold = toBoolean(body.hold, true);
  const global = toBoolean(body.global, false);

  const flags = global ? ['-g'] : [];
  const args = [hold ? 'hold' : 'unhold', ...flags, ...apps];

  const job = startJob({
    kind: (hold ? 'app.hold' : 'app.unhold') as JobKind,
    title: `${hold ? '锁定' : '解除锁定'}：${apps.join(', ')}`,
    target: apps.join(', '),
    execute: async (ctx) => translateResult(await ctx.scoop(args, { label: `scoop ${hold ? 'hold' : 'unhold'}`, timeoutMs: 5 * 60 * 1000 }), hold ? '锁定' : '解除锁定'),
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
    execute: async (ctx) => translateResult(await ctx.scoop(args, { label: 'scoop reset', timeoutMs: 15 * 60 * 1000 }), '重置'),
    onSettled: () => installedApps.invalidate(),
  });

  return c.json(envelope({ job }), 202);
});
