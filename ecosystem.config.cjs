/**
 * pm2 进程配置（常驻运行方案）。
 *
 *   pm2 start ecosystem.config.cjs --only scoop-manager
 *   pm2 start ecosystem.config.cjs --only scoop-manager-bun
 *   pm2 logs scoop-manager
 *   pm2 delete scoop-manager
 *
 * 两个 app 定义二选一即可：
 *   - scoop-manager     ：Node 运行时，跑 `pnpm run build` 产出的 dist/index.js（推荐生产环境）
 *   - scoop-manager-bun ：Bun 运行时，直接跑 TS 源码，无需构建（推荐开发/轻量部署）
 *
 * 注意：这里固定传了 --no-open，避免服务重启时反复弹出浏览器；
 * 需要自动打开时删掉对应 args 里的 --no-open 即可。
 */

/**
 * 端口与监听地址：可用环境变量覆盖，默认值即本机部署所用的值。
 *
 * ⚠️ PORT 必须与本机 pluse 网关 `/scoop` 路由的 `to` 保持一致
 *    （G:\active_project\pluse\config.local.json）。两者不一致时
 *    `/scoop` 会返回 502，而服务本身看起来一切正常。
 *    HOST 用 0.0.0.0 是为了兼容直连与局域网访问；仅经 pluse 访问时可改为 127.0.0.1。
 */
const PORT = process.env.SCOOP_MANAGER_PORT || '39180';
const HOST = process.env.SCOOP_MANAGER_HOST || '0.0.0.0';

const shared = {
  cwd: __dirname,
  // 3 秒内重启超过 8 次则判定为崩溃循环，停止重启，避免刷屏
  min_uptime: '3s',
  max_restarts: 8,
  // 内存超限自动重启，防止长期运行的日志缓冲堆积
  max_memory_restart: '300M',
  autorestart: true,
  watch: false,
  merge_logs: true,
  time: true,
  env: {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
  },
};

module.exports = {
  apps: [
    {
      ...shared,
      name: 'scoop-manager',
      script: 'dist/index.js',
      interpreter: 'node',
      args: `--no-open --port ${PORT} --host ${HOST}`,
      out_file: './logs/scoop-manager.out.log',
      error_file: './logs/scoop-manager.err.log',
    },
    {
      ...shared,
      name: 'scoop-manager-bun',
      script: 'src/index.ts',
      interpreter: 'bun',
      interpreter_args: '--smol',
      args: `--no-open --port ${PORT} --host ${HOST}`,
      out_file: './logs/scoop-manager-bun.out.log',
      error_file: './logs/scoop-manager-bun.err.log',
    },
  ],
};
