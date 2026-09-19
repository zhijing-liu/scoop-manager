/**
 * Scoop 配置与代理接口。
 */

import { Hono } from 'hono';
import { envelope } from '../server/errors.js';
import { assertConfigKey, safeJsonBody } from '../utils/validate.js';
import { startJob, translateResult } from '../jobs/execute.js';
import {
  COMMON_CONFIG_KEYS,
  buildRemoveArgs,
  buildSetArgs,
  readConfig,
  testProxy,
  validateProxyInput,
} from '../services/config-service.js';
import { readEffectiveProxy, setManagerProxy } from '../services/proxy-service.js';
import { detectScoop } from '../services/scoop-locator.js';

export const configRoutes = new Hono();

/** 任务标题里的代理密码要脱敏，避免落到日志与历史记录里。 */
function maskProxy(value: string): string {
  return value.replace(/(:)[^:@/]+(@)/, '$1***$2');
}

// 具体路径必须早于 /config/:key 注册
configRoutes.get('/config/keys', (c) => c.json(envelope({ items: COMMON_CONFIG_KEYS })));

configRoutes.get('/config/proxy', async (c) => {
  const [status, snapshot] = await Promise.all([readEffectiveProxy(), readConfig()]);
  return c.json(envelope({ ...status, file: snapshot.file }));
});

configRoutes.put('/config/proxy', async (c) => {
  const body = await safeJsonBody(c);
  const value = validateProxyInput(body.value);
  const env = await detectScoop();

  // Scoop 还没装：scoop config 不可用，而安装 Scoop 恰恰最需要代理。
  // 这里改存到本程序自身配置，安装时注入子进程环境（见 scoop-installer）。
  if (!env.installed) {
    setManagerProxy(value);
    const status = await readEffectiveProxy();
    return c.json(envelope({ job: null, proxy: status }));
  }

  const args = buildSetArgs('proxy', value);

  const job = startJob({
    kind: 'config.set',
    title: value === 'current' ? '设置代理：跟随系统' : value === 'none' ? '关闭代理' : `设置代理：${maskProxy(value)}`,
    target: 'proxy',
    execute: async (ctx) => translateResult(await ctx.scoop(args, { label: 'scoop config proxy', timeoutMs: 60_000 }), '设置代理'),
  });

  return c.json(envelope({ job }), 202);
});

configRoutes.delete('/config/proxy', async (c) => {
  const env = await detectScoop();

  // 同上：未安装时只需清掉本程序保存的值，没有 scoop 命令可跑
  if (!env.installed) {
    setManagerProxy(null);
    const status = await readEffectiveProxy();
    return c.json(envelope({ job: null, proxy: status }));
  }

  const args = buildRemoveArgs('proxy');
  const job = startJob({
    kind: 'config.remove',
    title: '清除代理配置',
    target: 'proxy',
    execute: async (ctx) => translateResult(await ctx.scoop(args, { label: 'scoop config rm proxy', timeoutMs: 60_000 }), '清除代理'),
  });
  return c.json(envelope({ job }), 202);
});

configRoutes.post('/config/proxy/test', async (c) => {
  // 允许先测后用：body.value 为空时测试当前已生效的代理
  let value: string | null = null;
  try {
    const body = await safeJsonBody(c);
    value = typeof body.value === 'string' && body.value.trim().length > 0 ? body.value.trim() : null;
  } catch {
    value = null;
  }
  if (!value) {
    const status = await readEffectiveProxy();
    value = status.value;
  }
  const result = await testProxy(value);
  return c.json(envelope(result));
});

// ------------------------------------------------------------------ 通用配置

configRoutes.get('/config', async (c) => {
  const snapshot = await readConfig();
  const effective = await readEffectiveProxy();
  return c.json(envelope({ ...snapshot, proxy: effective }));
});

configRoutes.put('/config', async (c) => {
  const body = await safeJsonBody(c);
  const key = assertConfigKey(body.key);
  const args = buildSetArgs(key, body.value);

  const job = startJob({
    kind: 'config.set',
    title: `设置配置：${key}`,
    target: key,
    execute: async (ctx) => translateResult(await ctx.scoop(args, { label: `scoop config ${key}`, timeoutMs: 60_000 }), `设置 ${key}`),
  });

  return c.json(envelope({ job }), 202);
});

configRoutes.delete('/config/:key', (c) => {
  const key = assertConfigKey(c.req.param('key'));
  const args = buildRemoveArgs(key);

  const job = startJob({
    kind: 'config.remove',
    title: `删除配置：${key}`,
    target: key,
    execute: async (ctx) => translateResult(await ctx.scoop(args, { label: `scoop config rm ${key}`, timeoutMs: 60_000 }), `删除 ${key}`),
  });

  return c.json(envelope({ job }), 202);
});
