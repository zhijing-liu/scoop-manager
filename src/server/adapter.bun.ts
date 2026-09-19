/**
 * Bun 运行时适配器。
 */

import { createLogger } from '../utils/logger.js';
import { bunRuntime } from '../runtime.js';

const logger = createLogger('adapter:bun');

export interface ServerOptions {
  port: number;
  host: string;
}

export interface ServerHandle {
  port: number;
  host: string;
  stop: () => Promise<void>;
}

export async function startBunServer(fetchHandler: (request: Request) => Response | Promise<Response>, options: ServerOptions): Promise<ServerHandle> {
  const bun = bunRuntime();
  if (!bun?.serve) {
    throw new Error('当前环境未提供 Bun.serve，无法以 Bun 运行时启动。');
  }

  const server = bun.serve({
    port: options.port,
    hostname: options.host,
    fetch: fetchHandler,
  });

  logger.info(`Bun 服务已启动: http://${options.host}:${server.port}`);

  return {
    port: server.port,
    host: options.host,
    stop: async () => {
      server.stop(true);
    },
  };
}
