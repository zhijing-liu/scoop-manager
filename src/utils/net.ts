/**
 * 网络工具：端口探测与代理连通性测试。
 */

import { createServer, connect } from 'node:net';

/** 尝试独占监听指定端口，用于判断端口是否可用。 */
export function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen({ port, host, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

/**
 * 从 preferred 开始向上寻找可用端口。
 * 找不到时抛错由调用方决定如何提示；这里只做最多 maxTries 次探测。
 */
export async function findAvailablePort(preferred: number, host: string, maxTries = 20): Promise<number | null> {
  for (let offset = 0; offset < maxTries; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65535) break;
    // 127.0.0.1 与 0.0.0.0 的占用情况可能不同，都测一遍更保险
    const free = (await isPortAvailable(candidate, host)) && (host === '0.0.0.0' || (await isPortAvailable(candidate, '0.0.0.0')));
    if (free) return candidate;
  }
  return null;
}

export interface TcpTestResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/** TCP 连通性测试：只验证到目标的握手是否成功，不发送任何应用层数据。 */
export function testTcp(host: string, port: number, timeoutMs = 5000): Promise<TcpTestResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (result: TcpTestResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, ms: Date.now() - started }));
    socket.once('timeout', () => finish({ ok: false, ms: Date.now() - started, error: '连接超时' }));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish({ ok: false, ms: Date.now() - started, error: error.code === 'ECONNREFUSED' ? '目标拒绝连接' : error.message });
    });
  });
}

/**
 * 把 scoop 的 proxy 配置值解析成可测试的 host/port。
 * 支持 http(s)://user:pass@host:port 与 host:port 两种形态。
 * `current` / `none` 无法直接解析，返回 null（由调用方给出提示）。
 */
export function parseProxyTarget(value: string): { host: string; port: number; secure: boolean } | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'current' || trimmed === 'none') return null;

  let rest = trimmed;
  let secure = false;
  const schemeMatch = /^(https?):\/\//i.exec(rest);
  if (schemeMatch) {
    secure = schemeMatch[1].toLowerCase() === 'https';
    rest = rest.slice(schemeMatch[0].length);
  }

  const atIndex = rest.lastIndexOf('@');
  if (atIndex >= 0) rest = rest.slice(atIndex + 1);
  rest = rest.split('/')[0];

  const colonIndex = rest.lastIndexOf(':');
  let host = rest;
  let port = secure ? 443 : 80;
  if (colonIndex > 0) {
    const portText = rest.slice(colonIndex + 1);
    const parsed = Number.parseInt(portText, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
      host = rest.slice(0, colonIndex);
      port = parsed;
    } else if (/^\d+$/.test(portText)) {
      return null;
    }
  }

  if (!host) return null;
  return { host, port, secure };
}
