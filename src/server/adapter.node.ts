/**
 * Node 运行时适配器。
 *
 * `@hono/node-server` 通过动态 import 引入：Bun 下走原生 Bun.serve，
 * 就完全不需要加载这个包（编译成 exe 时也能被摇掉一部分体积）。
 */

import { createLogger } from '../utils/logger.js';
import type { ServerHandle, ServerOptions } from './adapter.bun.js';

const logger = createLogger('adapter:node');

export async function startNodeServer(fetchHandler: (request: Request) => Response | Promise<Response>, options: ServerOptions): Promise<ServerHandle> {
  const { serve } = await import('@hono/node-server');

  return new Promise<ServerHandle>((resolve, reject) => {
    const server = serve(
      {
        fetch: fetchHandler,
        port: options.port,
        hostname: options.host,
      },
      (info) => {
        logger.info(`Node 服务已启动: http://${options.host}:${info.port}`);
        resolve({
          port: info.port,
          host: options.host,
          stop: async () => {
            await new Promise<void>((done) => server.close(() => done()));
          },
        });
      },
    );

    server.on('error', (error: NodeJS.ErrnoException) => {
      reject(error);
    });
  });
}
