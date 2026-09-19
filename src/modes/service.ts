/**
 * 服务模式（HTTP）。
 *
 * 行为与改造前完全一致：
 *   1. 找一个可用端口（默认端口被占用时自动后移，并明确告知用户）
 *   2. 按当前运行时（Bun / Node）选择适配器启动 HTTP 服务
 *   3. 打印横幅、可选地自动打开浏览器
 *   4. 注册优雅退出，把任务历史落盘
 *
 * 这是 `bun run dev` / `node dist/index.js` / pm2 / 双击 scoop-manager.exe
 * 的默认路径。桌面端（Tauri sidecar）不走这里，见 src/modes/desktop.ts。
 *
 * 注意：即使 Scoop 未安装、甚至不在 Windows 上，服务也会正常启动。
 * 前端的"首次引导"会把阻断原因展示清楚，而不是让进程直接崩掉。
 */

import { spawn } from 'node:child_process';
import {
  APP_NAME,
  APP_VERSION,
  DATA_DIR,
  getAppConfig,
  isWindows,
  type CliOptions,
} from '../config.js';
import { bunRuntime, runtime, runtimeLabel, setRuntime } from '../runtime.js';
import { createApp } from '../server/app.js';
import { startBunServer } from '../server/adapter.bun.js';
import { startNodeServer } from '../server/adapter.node.js';
import type { ServerHandle } from '../server/adapter.bun.js';
import { jobManager } from '../jobs/manager.js';
import { findAvailablePort } from '../utils/net.js';
import { createLogger } from '../utils/logger.js';
import { exists } from '../utils/fsx.js';
import { installProcessGuards, prepare } from './bootstrap.js';

const logger = createLogger('bootstrap');

/** 对外访问地址（含反向代理子路径），用于横幅展示与自动打开浏览器。 */
export function publicUrl(handle: { host: string; port: number }): string {
  const host = handle.host === '0.0.0.0' ? 'localhost' : handle.host;
  return `http://${host}:${handle.port}${getAppConfig().basePath}/`;
}

function printBanner(handle: ServerHandle, lines: string[]): void {
  const accent = process.stdout.isTTY ? '\u001b[36m' : '';
  const dim = process.stdout.isTTY ? '\u001b[90m' : '';
  const reset = process.stdout.isTTY ? '\u001b[0m' : '';
  const url = publicUrl(handle);

  const content = [
    `${accent}${APP_NAME}${reset} ${dim}v${APP_VERSION}${reset}`,
    '',
    `  访问地址   ${accent}${url}${reset}`,
    ...lines.map((line) => `  ${line}`),
    '',
    `${dim}  按 Ctrl+C 退出${reset}`,
  ];

  process.stdout.write(`\n${content.join('\n')}\n\n`);
}

function openBrowser(url: string): void {
  try {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    // Windows 下 `start` 的第一个参数是窗口标题，必须给一个空串
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    logger.info(`已尝试打开浏览器: ${url}`);
  } catch (error) {
    logger.warn(`自动打开浏览器失败（可手动访问）: ${(error as Error).message}`);
  }
}

/**
 * 把 Hono 应用接到运行时适配器上，顺带处理反向代理子路径。
 *
 * 反向代理有两种常见配置，二者都要能工作：
 *   a. 透传前缀：`proxy_pass http://127.0.0.1:3000;`   后端收到 /scoop/api/health
 *   b. 剥离前缀：`proxy_pass http://127.0.0.1:3000/;`  后端收到 /api/health
 *
 * 因此：配置了 basePath 时，先把请求上的前缀去掉再交给 Hono，
 * 这样 a 场景可用、b 场景（本来就没前缀）也天然不受影响。
 */
function createFetchHandler(app: ReturnType<typeof createApp>): (request: Request) => Response | Promise<Response> {
  return (request) => {
    const basePath = getAppConfig().basePath;
    if (!basePath) return app.fetch(request);

    const url = new URL(request.url);
    const path = url.pathname;

    // 恰好等于前缀（无尾斜杠）时补一个尾斜杠：
    // 前端资源用的是相对路径（css/… 、js/…），没有尾斜杠会被解析到上一层。
    // 用相对 Location，避免把内部监听地址泄露到客户端。
    if (path === basePath) {
      return new Response(null, { status: 308, headers: { Location: `${basePath}/` } });
    }

    if (!path.startsWith(`${basePath}/`)) return app.fetch(request);

    url.pathname = path.slice(basePath.length);
    return app.fetch(new Request(url, request));
  };
}

async function resolveServer(): Promise<ServerHandle> {
  const config = getAppConfig();
  const app = createApp();
  const fetchHandler = createFetchHandler(app);
  const starter = runtime.kind === 'bun' ? startBunServer : startNodeServer;

  const preferred = config.port;
  const available = await findAvailablePort(preferred, config.host);
  if (available === null) {
    throw new Error(`从端口 ${preferred} 开始连续 20 个端口都被占用，请用 --port 指定其他端口。`);
  }

  let port = available;
  setRuntime({ port, host: config.host, portShifted: port !== preferred });

  if (port !== preferred) {
    logger.warn(`端口 ${preferred} 已被占用，自动改用 ${port}。`);
  }

  // 极小概率的竞态：探测通过但 listen 失败，则继续向上试
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const handle = await starter(fetchHandler, { port, host: config.host });
      setRuntime({ port: handle.port });
      return handle;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw error;
      const next = await findAvailablePort(port + 1, config.host);
      if (next === null) throw error;
      logger.warn(`端口 ${port} 启动失败，改用 ${next}。`);
      port = next;
      setRuntime({ port, portShifted: true });
    }
  }

  throw new Error('多次尝试后仍无法绑定端口。');
}

export async function startServiceMode(cli: CliOptions): Promise<void> {
  installProcessGuards();

  const { config, scoopEnv, staticResolved } = await prepare(cli);

  const handle = await resolveServer();

  const lines = [
    `运行时     ${runtimeLabel()}${bunRuntime()?.isStandaloneExecutable ? ' (单文件模式)' : ''}`,
    `数据目录   ${DATA_DIR}`,
    `静态资源   ${staticResolved.source === 'disk' ? staticResolved.dir : staticResolved.source === 'embedded' ? '内嵌到可执行文件' : '未找到（界面将无法加载）'}`,
    `Scoop      ${scoopEnv.installed ? `${scoopEnv.root}（v${scoopEnv.version ?? '未知'}）` : '未检测到，请在页面上完成安装或指定路径'}`,
    `PowerShell ${scoopEnv.powershell.kind ?? '未找到'}`,
    `平台       ${isWindows() ? 'Windows' : `${process.platform}（Scoop 仅支持 Windows）`}`,
    ...(config.basePath
      ? [`访问前缀   ${config.basePath}/（反向代理子路径模式，同时兼容带/不带前缀的请求）`]
      : []),
    `配置提示   不设鉴权，请勿直接暴露到公网；需要外网访问时请自行在反向代理层限制`,
  ];

  printBanner(handle, lines);

  if (!staticResolved.source || staticResolved.source === 'none') {
    logger.error('未找到前端静态资源，页面会返回 404。开发态请在项目根目录启动，打包态请确认使用 --asset 内嵌了 public 目录。');
  }
  if (!exists(DATA_DIR)) {
    logger.debug(`数据目录将在首次写入时创建: ${DATA_DIR}`);
  }

  const url = publicUrl(handle);
  if (config.openBrowser) openBrowser(url);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在关闭…`);
    try {
      jobManager.flush();
      await handle.stop();
    } catch (error) {
      logger.warn(`关闭过程中出现异常: ${(error as Error).message}`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
}
