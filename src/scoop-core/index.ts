/**
 * scoop-core —— 与 Web 框架无关的 Scoop 操作能力层。
 *
 * 这个目录是"可以单独抽出去做成 npm 包"的代码。内部没有 Hono、没有 jobs 队列、
 * 没有 IPC 协议、没有桌面壳耦合；只有：
 *   - Scoop 命令参数注册表（options.ts）
 *   - PowerShell 启动 + 进程管理（powershell.ts / runner.ts / queue.ts）
 *   - Scoop 环境定位 + manifest 索引 + 已安装应用扫描（locator.ts / installed.ts / manifest.ts）
 *   - Bucket / Cache / Config / Proxy（bucket*.ts / cache.ts / config.ts / proxy.ts）
 *   - 高层操作入口（client.ts —— install/update/uninstall/...）
 *
 * 与外部解耦约定：
 *   - runner.RunOptions 通过 `cancelRequested` / `setCancelHandler` 回调注入取消能力，
 *     而不是 import src/jobs/manager。
 *   - runner.RunOptions 通过 `queue` 注入串行队列，不传时用内置的默认队列。
 *   - AppError 定义在 errors.ts；不与 src/server/errors.ts 互相引用，各自维护。
 */

export * from './errors.js';
export { createLogger, getLogLevel, setLogLevel, log, type Logger, type LogLevel } from './logger.js';
export { redactSecret as redactSecretLogger } from './logger.js';
export * from './powershell.js';
export * from './queue.js';
export * from './runner.js';
export * from './locator.js';
export * from './installer.js';
export * from './options.js';
export * from './installed.js';
export * from './manifest.js';
export * from './bucket-internal.js';
export { buildRemoveArgs as bucketRemoveArgs, buildAddArgs, buildBucketSyncPlan, listBuckets, knownBuckets, currentBucketNames, type BucketInfo, type BucketSyncPlan } from './bucket.js';
export * from './cache.js';
export { buildRemoveArgs as configRemoveArgs } from './config.js';
export { buildSetArgs, readConfig, COMMON_CONFIG_KEYS, testProxy, validateProxyInput } from './config.js';
export * from './proxy.js';
export * from './client.js';
export { scoopClient, createJobHook } from './instance.js';
