/**
 * Bucket 管理接口。
 */

import { Hono } from 'hono';
import { envelope } from '../server/errors.js';
import { assertName, safeJsonBody } from '../utils/validate.js';
import { startJob, translateResult } from '../jobs/execute.js';
import { buildAddArgs, buildBucketSyncPlan, buildRemoveArgs, listBuckets, knownBuckets } from '../scoop-core/bucket.js';
import { manifestIndex } from '../scoop-core/manifest.js';
import { installedApps, refreshScoopStatusCache } from '../scoop-core/installed.js';

export const bucketRoutes = new Hono();

// 注意：具体路径必须注册在参数路径之前
bucketRoutes.get('/buckets/known', async (c) => {
  const result = await knownBuckets();
  return c.json(envelope(result));
});

bucketRoutes.get('/buckets', async (c) => {
  const items = await listBuckets();
  return c.json(envelope({ items, index: manifestIndex.stats() }));
});

bucketRoutes.post('/buckets', async (c) => {
  const body = await safeJsonBody(c);
  const name = assertName(body.name, 'Bucket 名称');
  const repoUrl = typeof body.repoUrl === 'string' && body.repoUrl.trim().length > 0 ? body.repoUrl.trim() : null;

  // 提前构造一次参数，让格式错误在创建任务之前就暴露出来
  const args = buildAddArgs(name, repoUrl);

  const job = startJob({
    kind: 'bucket.add',
    title: `添加 Bucket：${name}`,
    target: name,
    execute: async (ctx) => translateResult(await ctx.scoop(args, { label: `scoop bucket add ${name}`, timeoutMs: 10 * 60 * 1000 }), `添加 Bucket ${name}`),
    onSettled: () => {
      manifestIndex.invalidate();
    },
  });

  return c.json(envelope({ job }), 202);
});

bucketRoutes.delete('/buckets/:name', (c) => {
  const name = assertName(c.req.param('name'), 'Bucket 名称');
  const args = buildRemoveArgs(name);

  const job = startJob({
    kind: 'bucket.remove',
    title: `删除 Bucket：${name}`,
    target: name,
    execute: async (ctx) => translateResult(await ctx.scoop(args, { label: `scoop bucket rm ${name}`, timeoutMs: 5 * 60 * 1000 }), `删除 Bucket ${name}`),
    onSettled: () => {
      manifestIndex.invalidate();
      installedApps.invalidate();
    },
  });

  return c.json(envelope({ job }), 202);
});

bucketRoutes.post('/buckets/update', async (c) => {
  const body = await safeJsonBody(c);
  const name = body.name === undefined || body.name === null || body.name === '' ? null : assertName(body.name, 'Bucket 名称');
  const plan = await buildBucketSyncPlan(name);

  const job = startJob({
    kind: 'bucket.update',
    title: name ? `更新 Bucket：${name}` : `更新全部 Bucket（${plan.buckets.length} 个）`,
    target: name ?? plan.buckets.join(', '),
    // target 在"更新全部"时是逗号拼接的全部名字，无法反推，
    // 因此重试统一走原始请求快照
    request: { method: 'POST', path: '/api/buckets/update', body },
    execute: async (ctx) => {
      ctx.log(`同步方式：git pull（Scoop 未提供 bucket update 子命令）`);
      if (plan.skipped.length > 0) {
        ctx.log(`跳过非 git 仓库的 bucket：${plan.skipped.join(', ')}`);
      }
      if (plan.viaProxy) {
        ctx.log('已透传 Scoop 配置的代理给 git（git 不读取 scoop 的代理设置）');
      } else {
        ctx.log('未检测到可用代理，git 将直连（如同步失败请先在「配置与代理」设置代理）');
      }
      return translateResult(
        await ctx.script(plan.script, {
          label: '同步 Bucket（git pull）',
          timeoutMs: 20 * 60 * 1000,
          env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        }),
        '更新 Bucket',
      );
    },
    onSettled: ({ status }) => {
      manifestIndex.invalidate();
      installedApps.invalidate();
      // bucket 刚 git pull 完，拿权威结果最有意义的时刻就是此刻。
      // fire-and-forget：后台串行队列会自己排队，不阻塞；失败静默。
      if (status === 'succeeded') void refreshScoopStatusCache();
    },
  });

  return c.json(envelope({ job }), 202);
});
