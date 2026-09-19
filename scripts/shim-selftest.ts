/**
 * 垫片自测（客户端侧）。
 *
 * 为什么需要它
 * ────────────
 * `desktop/shim/ipc-shim.js` 是注入进 WebView 的，常规测试够不到它；而它一旦出
 * 问题就是白屏级别 —— 前端取到的 fetch / EventSource 直接不可用。
 *
 * 已经踩过一次：早期用 ES5 风格继承 EventTarget
 *   function IpcEventSource(url) { EventTarget.call(this); ... }
 * 结果在 WebView 里抛
 *   Failed to construct 'EventTarget': Please use the 'new' operator,
 *   this DOM object constructor cannot be called as a function
 *
 * 垫片只依赖 window / location 与标准 Web API（EventTarget、Event、MessageEvent、
 * Response、URL、TextDecoder），这些在 Bun 里都有，因此用少量 stub 就能真实求值
 * 并断言行为。
 *
 * 用法：bun run test:shim
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SHIM_PATH = join(ROOT, 'desktop', 'shim', 'ipc-shim.js');

const failures: string[] = [];
let passed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  \u001b[32mPASS\u001b[0m  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

// ---------------------------------------------------------------- 测试环境

type Listener = (event: { payload?: unknown }) => void;

interface Harness {
  window: any;
  calls: Array<{ cmd: string; args: any }>;
  emit: (event: string, payload?: unknown) => void;
  listenerCount: () => number;
  released: string[];
  nativeFetchUrls: string[];
}

function packFrame(header: unknown, body: string): ArrayBuffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(headerBytes.length, 0);
  const bytes = Buffer.concat([prefix, headerBytes, Buffer.from(body, 'utf8')]);
  // 必须切片：Buffer 可能来自共享内存池，直接取 .buffer 会带上无关字节
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function install(globals: any): Harness {
  const listeners = new Map<string, Set<Listener>>();
  const calls: Array<{ cmd: string; args: any }> = [];
  const released: string[] = [];
  const nativeFetchUrls: string[] = [];

  const invoke = async (cmd: string, args: any): Promise<unknown> => {
    calls.push({ cmd, args });
    if (cmd === 'api_request') {
      return packFrame(
        { status: 200, headers: { 'content-type': 'application/json' }, bodyLength: 11 },
        '{"ok":true}',
      );
    }
    return null;
  };

  const listen = async (event: string, handler: Listener): Promise<() => void> => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      released.push(event);
    };
  };

  if (typeof globals.MessageEvent === 'undefined') {
    globals.MessageEvent = class MessageEvent extends Event {
      data: unknown;
      origin: string;
      constructor(type: string, init?: { data?: unknown; origin?: string }) {
        super(type);
        this.data = init?.data;
        this.origin = init?.origin ?? '';
      }
    };
  }

  const NativeEventSourceStub = class NativeEventSourceStub {
    constructor(public url: string) {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    addEventListener(): void {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    close(): void {}
  };

  const windowStub: any = {
    fetch: async (input: any) => {
      nativeFetchUrls.push(String(input));
      return new Response('native', { status: 418 });
    },
    EventSource: NativeEventSourceStub,
    __TAURI__: { core: { invoke }, event: { listen } },
  };

  globals.window = windowStub;
  globals.location = { origin: 'http://tauri.localhost' };

  return {
    window: windowStub,
    calls,
    released,
    nativeFetchUrls,
    emit: (event, payload) => {
      for (const handler of listeners.get(event) ?? []) handler({ payload });
    },
    listenerCount: () => {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  console.log(`\n垫片自测\n  目标  ${SHIM_PATH}\n`);

  const globals = globalThis as any;
  const originalFetch = globals.fetch;

  const harness = install(globals);

  // 在全局作用域求值：垫片是 IIFE，只依赖 window / location 与标准 Web API
  try {
    new Function(readFileSync(SHIM_PATH, 'utf8'))();
  } catch (error) {
    check('垫片可以被求值', false, (error as Error).message);
    console.log(`\n结果：${passed} 项通过，${failures.length} 项失败\n`);
    process.exit(1);
  }

  const NativeEventSource = harness.window.EventSource;

  check('垫片已接管 window.fetch', harness.window.fetch !== undefined && harness.window.fetch !== originalFetch);
  check('垫片已接管 window.EventSource', typeof harness.window.EventSource === 'function');

  // ---- EventSource 构造（历史 bug 的回归点）
  let source: any = null;
  try {
    source = new harness.window.EventSource('/api/jobs/abc/events?since=0');
    check('new EventSource(/api/**) 不抛异常', true);
  } catch (error) {
    check('new EventSource(/api/**) 不抛异常', false, (error as Error).message);
  }

  if (source) {
    await tick();

    const start = harness.calls.find((item) => item.cmd === 'api_stream_start');
    check('已发出 api_stream_start', Boolean(start), JSON.stringify(harness.calls.map((c) => c.cmd)));
    check('path 与 query 原样透传', start?.args.path === '/api/jobs/abc/events?since=0', String(start?.args.path));
    check('已注册 chunk / end / error 三类监听', harness.listenerCount() === 3, String(harness.listenerCount()));
    check('readyState 进入 OPEN', source.readyState === 1, String(source.readyState));

    // ---- 收到分块后按 SSE 语法派发事件
    const received: Array<{ type: string; data: string }> = [];
    for (const type of ['log', 'status', 'done', 'eof']) {
      source.addEventListener(type, (event: any) => received.push({ type, data: event.data }));
    }

    const streamId = start?.args.streamId;
    harness.emit(`rpc:chunk:${streamId}`, 'event: log\nid: 5\ndata: {"seq":5,"text":"hello"}\n\n');
    check('分块被解析为 log 事件', received.length === 1 && received[0]!.type === 'log', JSON.stringify(received));
    check('事件 data 内容正确', received[0]?.data === '{"seq":5,"text":"hello"}', String(received[0]?.data));

    // 分块边界可以任意切：半截事件必须缓冲，不能丢
    harness.emit(`rpc:chunk:${streamId}`, 'event: status\ndata: {"seq":6}');
    harness.emit(`rpc:chunk:${streamId}`, '\n\n');
    check('跨分块的事件被正确拼装', received.some((item) => item.type === 'status'), JSON.stringify(received));

    // 心跳（注释行）不应派发任何事件
    const before = received.length;
    harness.emit(`rpc:chunk:${streamId}`, ': ping\n\n');
    check('注释行（心跳）不派发事件', received.length === before, String(received.length - before));

    // ---- close() 释放监听并通知 Rust
    source.close();
    check('close() 后释放全部监听', harness.listenerCount() === 0, String(harness.listenerCount()));
    check('close() 后 readyState 为 CLOSED', source.readyState === 2, String(source.readyState));
    check(
      'close() 通知 Rust 取消流',
      harness.calls.some((item) => item.cmd === 'api_stream_cancel'),
      JSON.stringify(harness.calls.map((c) => c.cmd)),
    );
  }

  // ---- fetch 代理
  const apiResponse = await harness.window.fetch('/api/health');
  check('/api/** 走 IPC 并返回 200', apiResponse.status === 200, String(apiResponse.status));
  check('响应体正确解码', (await apiResponse.text()) === '{"ok":true}');

  const requestCall = harness.calls.find((item) => item.cmd === 'api_request');
  check('api_request 的 path / method 正确', requestCall?.args.path === '/api/health' && requestCall?.args.method === 'GET');

  const postResponse = await harness.window.fetch('/api/apps/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"a":1}',
  });
  check('POST 带 body 正常', postResponse.status === 200, String(postResponse.status));
  const postCall = harness.calls.filter((item) => item.cmd === 'api_request').pop();
  check('请求体与 Content-Type 透传', postCall?.args.body === '{"a":1}' && postCall?.args.headers['content-type'] === 'application/json');

  // ---- 不该接管的请求必须放行
  await harness.window.fetch('https://example.com/x');
  await harness.window.fetch('/css/style.css');
  check(
    '跨域与非 /api 同源请求交回原生 fetch',
    harness.nativeFetchUrls.length === 2,
    JSON.stringify(harness.nativeFetchUrls),
  );

  // ---- 非 /api 地址的 EventSource 回退到原生实现
  const fallback = new harness.window.EventSource('https://example.com/stream');
  check('非 /api 的 EventSource 回退到原生实现', fallback.url === 'https://example.com/stream');
  check('回退实例仍是原生类型', fallback instanceof NativeEventSource);

  console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length > 0) {
    console.log('\n失败明细：');
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
  console.log('垫片自测全部通过。\n');
}

void main();
