#!/usr/bin/env node
/**
 * 入口：唯一的模式分派点。
 *
 * 两种运行形态在这里彻底分叉，之后互不感知：
 *
 *   服务模式（默认）—— HTTP + TCP 端口
 *     bun run dev / node dist/index.js / pm2 / 双击 scoop-manager.exe
 *     实现见 src/modes/service.ts
 *
 *   应用模式（--rpc stdio）—— stdin/stdout 分帧，零端口
 *     仅由桌面端外壳（Tauri sidecar）拉起
 *     实现见 src/modes/desktop.ts
 *
 * 业务内核（server/app.ts、routes、services、jobs）对两种模式完全无感知，
 * 传输差异只允许出现在 src/modes/ 与 src/server/adapter.*.ts 两层。
 */

import { APP_VERSION, helpText, parseCliArgs } from './config.js';
import { createLogger } from './utils/logger.js';
import { startServiceMode } from './modes/service.js';
import { startDesktopMode } from './modes/desktop.js';

const logger = createLogger('bootstrap');

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));

  if (cli.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (cli.version) {
    process.stdout.write(`${APP_VERSION}\n`);
    return;
  }

  if (cli.rpc === 'stdio') {
    await startDesktopMode(cli);
    return;
  }

  await startServiceMode(cli);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`启动失败: ${message}`);
  if (process.env['DEBUG'] || process.env['LOG_LEVEL'] === 'debug') {
    console.error(error);
  }
  process.exit(1);
});
