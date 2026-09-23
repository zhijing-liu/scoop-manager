/**
 * 两种运行模式共用的启动前置。
 *
 * 抽出来的目的：让 service.ts（HTTP）与 desktop.ts（IPC）只在"传输方式"上分叉，
 * 其余启动逻辑（配置加载、日志级别、Scoop 预探测、静态资源定位）完全一致，
 * 避免两份实现逐渐漂移。
 */

import {
  applyAppConfig,
  getAppConfig,
  loadAppConfig,
  type AppConfig,
  type CliOptions,
} from '../config.js';
import { createLogger, setLogLevel, type LogLevel } from '../utils/logger.js';
import { detectScoop, invalidateScoopEnvironment } from '../scoop-core/locator.js';
import { staticInfo } from '../server/static.js';
import { normalizeBasePath, toAbsolute } from '../utils/paths.js';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface PreparedContext {
  config: AppConfig;
  scoopEnv: Awaited<ReturnType<typeof detectScoop>>;
  staticResolved: ReturnType<typeof staticInfo>;
}

/**
 * 完成启动前置并返回上下文。
 *
 * 顺序有讲究：配置必须先落地，因为 scoop 探测与端口解析都可能读取配置。
 */
export async function prepare(cli: CliOptions): Promise<PreparedContext> {
  if (cli.logLevel && LOG_LEVELS.includes(cli.logLevel as LogLevel)) {
    setLogLevel(cli.logLevel as LogLevel);
  }

  loadAppConfig();

  const patch: Parameters<typeof applyAppConfig>[0] = {};
  if (cli.port !== undefined) patch.port = cli.port;
  if (cli.host !== undefined) patch.host = cli.host;
  if (cli.openBrowser !== undefined) patch.openBrowser = cli.openBrowser;
  if (cli.scoopPath !== undefined) patch.scoopPath = toAbsolute(cli.scoopPath);
  if (cli.basePath !== undefined) patch.basePath = normalizeBasePath(cli.basePath);
  if (Object.keys(patch).length > 0) {
    // 桌面端会传 --no-persist：CLI 覆盖只作用于本次进程，不污染用户的配置文件。
    // 注意这不影响 UI 通过 API 做的修改，那些照常落盘。
    applyAppConfig(patch, { persist: cli.persist !== false });
  }

  const config = getAppConfig();

  // 启动即完成一次环境探测，让日志里直接能看到结论
  invalidateScoopEnvironment();
  const scoopEnv = await detectScoop(true);

  return { config, scoopEnv, staticResolved: staticInfo() };
}

/**
 * 注册进程级兜底错误处理。
 *
 * 两种模式都需要，原来内联在 main() 里，抽到此处避免重复。
 */
export function installProcessGuards(): void {
  const logger = createLogger('bootstrap');

  process.on('unhandledRejection', (reason) => {
    logger.error(`未处理的 Promise 拒绝: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });

  process.on('uncaughtException', (error) => {
    logger.error(`未捕获异常: ${error.stack ?? error.message}`);
  });
}
