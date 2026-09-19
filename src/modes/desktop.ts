/**
 * 应用模式（IPC，零端口）。
 *
 * 由桌面端外壳（Tauri）以 sidecar 方式拉起：
 *
 *   scoop-manager --rpc stdio --no-open --no-persist --parent-pid <pid>
 *
 * 与 service.ts 的关键差异（也是"两种模式彻底隔离"的体现）：
 *   - 不调用 findAvailablePort、不绑定任何 TCP 端口
 *   - 不打印横幅（stdout 是协议通道，只能出现帧）
 *   - 不自动打开浏览器（没有端口可开）
 *   - 静态资源由外壳提供，本进程只负责 /api
 *   - 退出由「shutdown 控制帧 / stdin EOF / 父进程消失」三者之一触发
 */

import { APP_NAME, APP_VERSION, DATA_DIR, type CliOptions } from '../config.js';
import { runtimeLabel, setTransport } from '../runtime.js';
import { createApp } from '../server/app.js';
import { serveIpc } from '../server/adapter.ipc.js';
import { jobManager } from '../jobs/manager.js';
import { createLogger } from '../utils/logger.js';
import { watchParent } from '../utils/parent-guard.js';
import { installProcessGuards, prepare } from './bootstrap.js';

const logger = createLogger('desktop');

export async function startDesktopMode(cli: CliOptions): Promise<void> {
  // 必须最早设置：logger 据此把日志全部改走 stderr，避免污染 stdout 的协议流。
  // 这一步哪怕早一行、晚一行都不行 —— prepare() 里就会产生日志。
  process.env['SCOOP_MANAGER_RPC'] = '1';
  setTransport('ipc');

  installProcessGuards();

  const { config, scoopEnv, staticResolved } = await prepare(cli);

  logger.info(`${APP_NAME} v${APP_VERSION} 以 IPC 模式启动（不监听任何端口）`);
  logger.info(`运行时     ${runtimeLabel()}`);
  logger.info(`数据目录   ${DATA_DIR}`);
  logger.info(`静态资源   ${staticResolved.source}（页面由桌面外壳提供，本进程只服务 /api）`);
  logger.info(
    `Scoop      ${scoopEnv.installed ? `${scoopEnv.root}（v${scoopEnv.version ?? '未知'}）` : '未检测到，请在页面上完成安装或指定路径'}`,
  );
  if (config.basePath) {
    // IPC 模式下页面与接口天然同源，前缀没有意义，只是提醒用户配置里残留了它
    logger.warn(`配置中存在 basePath=${config.basePath}，IPC 模式下不生效（同源无需前缀）。`);
  }

  let stopping = false;
  let stopParentWatch: (() => void) | null = null;

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info(`正在关闭（${reason}）…`);
    stopParentWatch?.();
    try {
      jobManager.flush();
    } catch (error) {
      logger.warn(`任务历史落盘失败: ${(error as Error).message}`);
    }
    process.exit(0);
  }

  // 桌面外壳被强杀时，OS 不会连带结束子进程，这里做兜底自清理
  if (cli.parentPid) {
    stopParentWatch = watchParent(cli.parentPid, () => void shutdown('父进程退出'));
    logger.info(`已启用父进程守护（PID ${cli.parentPid}）`);
  }

  // 与 service.ts 不同：这里不做 basePath 前缀剥离 —— IPC 请求路径天然就是
  // 前端的 /api/... ，没有反向代理这一层。
  const app = createApp();

  logger.info('IPC 通道已就绪。');

  try {
    await serveIpc((request) => app.fetch(request), {
      onShutdown: () => jobManager.flush(),
    });
  } catch (error) {
    logger.error(`IPC 通道异常退出: ${(error as Error).message}`);
    await shutdown('IPC 通道异常');
  }
}
