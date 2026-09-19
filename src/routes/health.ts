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
import { mutationQueue } from '../jobs/queue.js';
import { detectScoop } from '../services/scoop-locator.js';
import { bunRuntime, runtime, runtimeLabel } from '../runtime.js';

export const healthRoutes = new Hono();

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
      jobs: { running: jobManager.runningCount(), queued: mutationQueue.pending },
      scoop: {
        installed: env.installed,
        root: env.root,
        version: env.version,
        powershell: env.powershell.kind,
      },
    }),
  );
});
