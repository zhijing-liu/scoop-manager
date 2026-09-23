/**
 * IPC 传输适配器（桌面端专用，零端口）。
 *
 * 背景
 * ────
 * 桌面端要求「不占用任何端口」。而整套 API 逻辑都在 Hono 里，Hono 的核心入口
 * `app.fetch(request)` 接收标准 `Request`、返回标准 `Response`，本身与网络无关。
 * 于是这里把 stdin/stdout 当作传输通道，复用同一个 fetch handler：
 *
 *   stdin  ← 长度前缀分帧的请求
 *   stdout → 长度前缀分帧的响应
 *
 * 为什么不用 NDJSON
 * ────────────────
 * NDJSON 要求 body 是合法 JSON 字符串，body 会被 JSON 转义一次；而 Tauri 的
 * invoke 信封还会再转义一次。大响应（应用列表、搜索结果）会白白付出两次转义
 * 与约 30% 的体积膨胀。改用长度前缀后，body 以**原始字节**直传，全链路零转义。
 *
 * 帧格式
 * ──────
 *   u32 BE headerLength | JSON header (UTF-8) | body (bodyLength 字节)
 *
 * 入站（外壳 → 本进程）
 *   { "id": "r1", "method": "GET", "path": "/api/health", "headers": {}, "bodyLength": 0 }
 *   { "type": "shutdown" }                       ← 控制帧，触发优雅退出
 *
 * 出站（本进程 → 外壳）
 *   { "type": "ready", "schema": 2, "pid": 123 }
 *   { "type": "response", "id", "status", "headers", "bodyLength", "stream": false } + body
 *   { "type": "response", "id", "status", "headers", "bodyLength": 0, "stream": true }
 *   { "type": "chunk", "id", "bodyLength" } + body
 *   { "type": "end", "id" }
 *   { "type": "error", "id", "message" }
 *
 * 普通响应只有 `response` 一帧（body 直接挂在尾部）；只有 SSE 才会出现
 * `chunk` / `end`。外壳据此判断，不需要额外往返。
 */

import type { Hono } from 'hono';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('adapter:ipc');

/** 协议版本，外壳会校验；两侧必须同步升级 */
export const IPC_PROTOCOL_SCHEMA = 2;

/** 构造「假 URL」用的基准，只为让 URL 解析可用，不代表任何真实地址 */
const VIRTUAL_ORIGIN = 'http://ipc.local';

interface RequestHeader {
  id?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}

type OutHeader =
  | { type: 'ready'; schema: number; pid: number }
  | { type: 'response'; id: string; status: number; headers: Record<string, string>; bodyLength: number; stream: boolean }
  | { type: 'chunk'; id: string; bodyLength: number }
  | { type: 'end'; id: string }
  | { type: 'error'; id: string; message: string };

export interface IpcAdapterOptions {
  /** 收到 shutdown 控制帧或 stdin 关闭时调用，用于落盘等收尾工作 */
  onShutdown?: () => void | Promise<void>;
  /** 覆盖协议版本（测试用） */
  schema?: number;
}

// ---------------------------------------------------------------- 写帧

/**
 * 写一帧。
 *
 * 刻意用 cork/uncork 分三次 write 而不是 Buffer.concat：body 可能是上百 KB 的
 * 响应体，concat 会多一次完整拷贝。cork 让 Node 把三次写入合并成一次系统调用。
 *
 * @returns 是否还有余量（false 表示需要等待 drain 再继续写）
 */
function writeFrame(header: OutHeader, body?: Uint8Array): boolean {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(headerBytes.length, 0);

  const out = process.stdout;
  let ok = true;
  // uncork 必须放在 finally：中途 write 抛错时若不 uncork，stdout 会永久
  // 停留在 corked 状态，后续所有帧都被憋在缓冲区发不出去。
  out.cork();
  try {
    out.write(prefix);
    out.write(headerBytes);
    if (body && body.length > 0) ok = out.write(body);
  } finally {
    out.uncork();
  }
  return ok;
}

/** 等待 stdout 排空，用于 SSE 长流避免无界积压。 */
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.once('drain', resolve);
  });
}

// ---------------------------------------------------------------- 读帧

interface IncomingFrame {
  header: Record<string, unknown>;
  body: Buffer;
}

/**
 * 增量分帧器。
 *
 * 必须自己处理粘包/拆包：管道一次 read 可能带回多个帧，也可能只有半个帧。
 * 这里不做流式 yield，而是 push 返回本次能完整解出的帧数组，逻辑更直观。
 */
class FrameReader {
  /** 超过该尺寸的 body 单独拷贝一份，与读缓冲脱钩 */
  private static readonly COPY_BODY_THRESHOLD = 64 * 1024;

  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): IncomingFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: IncomingFrame[] = [];

    for (;;) {
      if (this.buffer.length < 4) break;

      const headerLength = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + headerLength) break;

      let header: Record<string, unknown>;
      try {
        header = JSON.parse(this.buffer.subarray(4, 4 + headerLength).toString('utf8')) as Record<string, unknown>;
      } catch {
        // 头都解析不了就无法确定 body 长度，只能丢弃整个缓冲重新同步
        logger.warn('收到无法解析的帧头，已重置读取缓冲。');
        this.buffer = Buffer.alloc(0);
        break;
      }

      const bodyLength = Number(header['bodyLength'] ?? 0);
      if (!Number.isFinite(bodyLength) || bodyLength < 0) {
        logger.warn(`帧头中的 bodyLength 非法（${String(header['bodyLength'])}），已重置读取缓冲。`);
        this.buffer = Buffer.alloc(0);
        break;
      }

      if (this.buffer.length < 4 + headerLength + bodyLength) break;

      const bodyStart = 4 + headerLength;
      let body = this.buffer.subarray(bodyStart, bodyStart + bodyLength);
      // subarray 是共享底层内存的视图：并发处理多个帧时，大 body 视图会把整块
      // 读缓冲（含同一批的其他帧）钉在内存里直到 handler 完成。大 body 主动拷贝
      // 一份断链，小 body 保持零拷贝。
      if (bodyLength > FrameReader.COPY_BODY_THRESHOLD) {
        body = Buffer.from(body);
      }
      frames.push({ header, body });
      this.buffer = this.buffer.subarray(bodyStart + bodyLength);
    }

    return frames;
  }
}

// ---------------------------------------------------------------- 请求处理

/**
 * 并发上限。
 *
 * IPC 请求虽然全部来自本机外壳，但外壳可能在短时间内突发大量请求（列表刷新、
 * 搜索、批量操作）。Hono 处理器中的 JSON 序列化、磁盘扫描是 CPU 密集型工作，
 * 不加限制会把事件循环打爆，反而让 SSE 日志推送卡顿。
 *
 * 槽位只覆盖"处理器执行"阶段（拿到 Response 即释放），不覆盖 SSE 后续的 chunk
 * 泵送：长连接可能挂几十分钟，把它们计入槽位会让普通请求被几条日志流饿死；
 * chunk 泵送本身已有 stdout 背压（drain）保护。
 */
const MAX_CONCURRENT_HANDLERS = 32;
let activeHandlers = 0;
const handlerWaiters: Array<() => void> = [];

function acquireHandlerSlot(): Promise<void> {
  if (activeHandlers < MAX_CONCURRENT_HANDLERS) {
    activeHandlers += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    handlerWaiters.push(resolve);
  });
}

function releaseHandlerSlot(): void {
  const next = handlerWaiters.shift();
  if (next) {
    // 直接交接槽位：计数不变，唤醒等待者
    next();
  } else {
    activeHandlers -= 1;
  }
}

async function handleRequest(
  handler: (request: Request) => Response | Promise<Response>,
  frame: IncomingFrame,
  id: string,
): Promise<void> {
  const header = frame.header as RequestHeader;
  const method = (header.method ?? 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && frame.body.length > 0;

  let response: Response;
  try {
    await acquireHandlerSlot();
    try {
      response = await handler(
        new Request(new URL(header.path ?? '/', VIRTUAL_ORIGIN), {
          method,
          headers: header.headers ?? {},
          ...(hasBody ? { body: frame.body } : {}),
        }),
      );
    } finally {
      releaseHandlerSlot();
    }
  } catch (error) {
    writeFrame({ type: 'error', id, message: (error as Error).message });
    return;
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // SSE 是唯一的流式响应形态（见 src/routes/jobs.ts）。用显式标志位而不是
  // 嗅探 content-type：外壳侧无需理解 HTTP 语义。
  const isStream = (headers['content-type'] ?? '').includes('text/event-stream');

  if (isStream) {
    writeFrame({ type: 'response', id, status: response.status, headers, bodyLength: 0, stream: true });

    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const ok = writeFrame({ type: 'chunk', id, bodyLength: value.length }, value);
          // 日志可能瞬间涌入上万行，尊重背压避免 stdout 无界积压
          if (!ok) await drain();
        }
      } catch (error) {
        // 不能用 end 收尾：外壳无法区分"正常结束"与"中途断裂"，前端会以为
        // 日志完整。error 帧会被 bridge.rs 转成 rpc:error 事件（shim 已监听）。
        const message = `SSE 转发中断：${(error as Error).message}`;
        logger.debug(message);
        writeFrame({ type: 'error', id, message });
        return;
      }
    }

    writeFrame({ type: 'end', id });
    return;
  }

  let bytes: Buffer;
  try {
    bytes = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  } catch (error) {
    // 异常若从这里逸出会变成未处理的 Promise 拒绝：外壳收不到任何帧，
    // 只能一路等到 120 秒请求超时，且用户看不到任何原因。
    writeFrame({ type: 'error', id, message: `读取响应体失败：${(error as Error).message}` });
    return;
  }
  writeFrame({ type: 'response', id, status: response.status, headers, bodyLength: bytes.length, stream: false }, bytes);
}

// ---------------------------------------------------------------- 入口

/**
 * 以 IPC 模式伺服 Hono 应用。本函数会一直挂起，直到收到 shutdown 控制帧、
 * stdin 关闭，或 process.exit 被调用。
 */
export async function serveIpc(
  handler: (request: Request) => Response | Promise<Response>,
  options: IpcAdapterOptions = {},
): Promise<void> {
  let stopping = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info(`IPC 通道关闭（${reason}）。`);
    try {
      await options.onShutdown?.();
    } catch (error) {
      logger.warn(`收尾工作失败: ${(error as Error).message}`);
    }
    process.exit(0);
  };

  // 就绪通知：本模式没有端口，外壳只需要知道"服务可用"以及协议版本
  writeFrame({ type: 'ready', schema: options.schema ?? IPC_PROTOCOL_SCHEMA, pid: process.pid });

  const reader = new FrameReader();

  const input = process.stdin;
  input.on('data', (chunk: Buffer) => {
    if (stopping) return;
    for (const frame of reader.push(chunk)) {
      if (frame.header['type'] === 'shutdown') {
        void shutdown('收到 shutdown 控制帧');
        return;
      }
      const id = (frame.header as RequestHeader).id;
      if (!id) continue;
      // 并发处理：Hono 应用本身是无状态的，每个请求独立
      void handleRequest(handler, frame, id);
    }
  });

  // stdin 关闭 = 外壳已消失（正常退出、崩溃、被强杀都会走到这里）
  input.on('end', () => void shutdown('stdin 已关闭'));
  input.on('close', () => void shutdown('stdin 已关闭'));
  input.on('error', () => void shutdown('stdin 读取异常'));

  input.resume();

  // 永久挂起：进程由 stdin 事件驱动，这里只是不让函数提前返回
  await new Promise<void>(() => {});
}

/** 便于测试：直接把 Hono 应用接上 IPC 通道 */
export function serveIpcApp(app: Hono, options: IpcAdapterOptions = {}): Promise<void> {
  return serveIpc((request) => app.fetch(request), options);
}
