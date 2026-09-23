/**
 * 健康检查与运行时元信息。
 *
 * 这个接口同时也是排障入口：把静态资源来源、PowerShell 类型、scoop 定位结果
 * 一次性暴露出来，出问题时不必翻日志。
 */

import { Hono } from 'hono';
import { APP_DESCRIPTION, APP_NAME, APP_VERSION, DATA_DIR, getAppConfig } from '../config.js';
import { envelope } from '../server/errors.js';
import { staticInfo } from '../server/static.js';
import { jobManager } from '../jobs/manager.js';
import { mutationQueue } from '../scoop-core/queue.js';
import { detectScoop } from '../scoop-core/locator.js';
import { refreshScoopStatusCache } from '../scoop-core/installed.js';
import { invalidateAllCaches } from '../scoop-core/resync.js';
import { bunRuntime, runtime, runtimeLabel } from '../runtime.js';

export const healthRoutes = new Hono();

/**
 * 一键重新同步：作废所有进程内缓存。
 *
 * 专治「用户在外部命令行直接操作过 Scoop，界面数据与磁盘不一致」：
 * `scoop hold` 这类只改文件内容、不改父目录 mtime 的操作，目录快照捕捉不到，
 * 必须显式作废。接口只清缓存、秒回，随后在后台重跑一次 `scoop status`，
 * 让可更新列表尽快回到联网权威结果（前端会做有限轮询等待回填）。
 *
 * 不会修改任何 Scoop 数据，纯读操作。
 */
healthRoutes.post('/system/resync', (c) => {
  const cleared = invalidateAllCaches();
  void refreshScoopStatusCache();
  return c.json(envelope({ cleared, refreshedAt: Date.now() }));
});

healthRoutes.get('/health', async (c) => {
  const env = await detectScoop();
  return c.json(
    envelope({
      name: APP_NAME,
      description: APP_DESCRIPTION,
      version: APP_VERSION,
      runtime: runtimeLabel(),
      kind: runtime.kind,
      standalone: bunRuntime()?.isStandaloneExecutable === true,
      platform: process.platform,
      supported: process.platform === 'win32',
      dataDir: DATA_DIR,
      uptimeSeconds: Math.round(process.uptime()),
      /**
       * 传输模式。
       *   'http' → 服务模式，server.host/port 有意义
       *   'ipc'  → 桌面应用模式，不监听任何端口，port 恒为 0
       * 前端据此决定顶部胶囊显示端口还是「桌面模式 · 无端口」。
       */
      transport: runtime.transport,
      server: { host: runtime.host, port: runtime.port, portShifted: runtime.portShifted },
      /** 反向代理子路径；空串表示部署在根路径 */
      basePath: getAppConfig().basePath,
      static: staticInfo(),
      jobs: { running: jobManager.runningCount(), queued: mutationQueue.queued },
      scoop: {
        installed: env.installed,
        root: env.root,
        version: env.version,
        powershell: env.powershell.kind,
      },
    }),
  );
});
