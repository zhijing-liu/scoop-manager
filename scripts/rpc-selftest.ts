/**
 * IPC 协议自测脚本。
 *
 * 用法：
 *   bun run test:ipc
 *
 * 这是阶段 1 的硬闸门：只有它全绿，才允许继续做 Rust 外壳。原因是一旦帧格式
 * 在 TS / Rust / JS 三处不一致，排查成本会翻好几倍。
 *
 * 覆盖范围
 *   1. ready 帧与协议版本
 *   2. GET  /api/health             —— transport === 'ipc' 且未监听端口
 *   3. GET  /api/config/keys        —— 纯内存接口，验证 JSON 信封与 body 路径
 *   4. GET  /api/jobs?limit=1       —— 验证 path 中的 query string
 *   5. GET  /api/__missing__        —— 404 错误信封
 *   6. POST /api/apps/status + SSE  —— 流式路径（stream 标志 + chunk + end）
 *   7. shutdown 控制帧              —— 优雅退出，退出码 0
 *   8. stdout 洁净性                —— 只允许出现合法帧
 *
 * 全程使用独立的 SCOOP_MANAGER_HOME（临时目录），不会影响本机真实配置。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

/**
 * 被测目标。默认跑源码入口（bun 直接执行 TS）；
 * 传入 `.exe` 路径时改为直接运行编译产物 —— 那是真正会被 Tauri 当作 sidecar
 * 拉起的形态，必须单独验一次。
 */
const TARGET = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'src', 'index.ts');
const IS_EXECUTABLE = /\.exe$/i.test(TARGET);

const EXPECTED_SCHEMA = 2;

interface Frame {
  type?: string;
  id?: string;
  status?: number;
  headers?: Record<string, string>;
  bodyLength?: number;
  stream?: boolean;
  message?: string;
  schema?: number;
  pid?: number;
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

interface ResponseWithJson extends Reply {
  json: any;
}

// ---------------------------------------------------------------- 客户端

class IpcClient {
  readonly child: ChildProcessWithoutNullStreams;
  /** stdout 上出现过的非协议文本（正常情况下必须为空） */
  readonly noise: string[] = [];
  stderr = '';
  exitCode: number | null = null;
  exited = false;
  /** 退出后仍残留在缓冲里的字节（说明帧不完整） */
  leftover = 0;

  private buffer: Buffer = Buffer.alloc(0);
  private seq = 0;
  private readonly waiting = new Map<string, (reply: Reply) => void>();
  private readonly streamHandlers = new Map<string, (kind: 'chunk' | 'end', body: Buffer) => void>();
  private readonly streamHeaders = new Map<string, Frame>();
  private readyResolve!: (frame: Frame) => void;

  readonly ready: Promise<Frame>;

  constructor(target: string, executable: boolean, home: string) {
    this.ready = new Promise<Frame>((resolveReady) => {
      this.readyResolve = resolveReady;
    });

    const [file, prefix] = executable ? [target, [] as string[]] : [process.execPath, [target]];

    this.child = spawn(file, [...prefix, '--rpc', 'stdio', '--no-persist'], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SCOOP_MANAGER_HOME: home },
    });

    this.child.stdout.on('data', (chunk: Buffer) => this.push(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
    this.child.on('exit', (code) => {
      this.exitCode = code;
      this.exited = true;
      this.leftover = this.buffer.length;
    });
  }

  // ------------------------------------------------------------ 帧写入

  send(header: Record<string, unknown>, body?: Buffer): void {
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(headerBytes.length, 0);
    this.child.stdin.write(Buffer.concat([prefix, headerBytes, body ?? Buffer.alloc(0)]));
  }

  // ------------------------------------------------------------ 帧读取

  private push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.length < 4) return;

      const headerLength = this.buffer.readUInt32BE(0);
      if (headerLength > 1024 * 1024) {
        // 头长超过 1MB 只可能是把日志文本误当成了帧头
        this.noise.push(this.buffer.subarray(0, 200).toString('utf8'));
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 4 + headerLength) return;

      let header: Frame;
      try {
        header = JSON.parse(this.buffer.subarray(4, 4 + headerLength).toString('utf8')) as Frame;
      } catch {
        this.noise.push(this.buffer.subarray(0, 200).toString('utf8'));
        this.buffer = Buffer.alloc(0);
        return;
      }

      const bodyLength = Number(header.bodyLength ?? 0);
      if (this.buffer.length < 4 + headerLength + bodyLength) return;

      const bodyStart = 4 + headerLength;
      const body = Buffer.from(this.buffer.subarray(bodyStart, bodyStart + bodyLength));
      this.buffer = this.buffer.subarray(bodyStart + bodyLength);
      this.dispatch(header, body);
    }
  }

  private dispatch(header: Frame, body: Buffer): void {
    const id = header.id;
    switch (header.type) {
      case 'ready':
        this.readyResolve(header);
        return;

      case 'response': {
        if (!id) return;
        if (header.stream) {
          this.streamHeaders.set(id, header);
          return;
        }
        const resolver = this.waiting.get(id);
        if (resolver) {
          this.waiting.delete(id);
          resolver({ status: header.status ?? 0, headers: header.headers ?? {}, body });
        }
        return;
      }

      case 'chunk':
        if (id) this.streamHandlers.get(id)?.('chunk', body);
        return;

      case 'end':
        if (id) this.streamHandlers.get(id)?.('end', Buffer.alloc(0));
        return;

      case 'error': {
        if (!id) return;
        const resolver = this.waiting.get(id);
        if (resolver) {
          this.waiting.delete(id);
          resolver({ status: 502, headers: {}, body: Buffer.from(header.message ?? '', 'utf8') });
        }
        return;
      }

      default:
        return;
    }
  }

  // ------------------------------------------------------------ 请求

  async request(method: string, path: string, payload?: unknown): Promise<ResponseWithJson> {
    const id = `r${++this.seq}`;
    const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), 'utf8');

    const promise = new Promise<Reply>((resolveOnce, rejectOnce) => {
      this.waiting.set(id, resolveOnce);
      setTimeout(() => {
        if (this.waiting.delete(id)) {
          rejectOnce(new Error(`请求超时：${method} ${path}（若 stdout 被日志污染会表现为超时，请检查 stderr）`));
        }
      }, 60000).unref?.();
    });

    this.send(
      {
        id,
        method,
        path,
        headers: body.length > 0 ? { 'content-type': 'application/json' } : {},
        bodyLength: body.length,
      },
      body,
    );

    const reply = await promise;
    let json: unknown = null;
    try {
      json = JSON.parse(reply.body.toString('utf8'));
    } catch {
      json = null;
    }
    return { ...reply, json };
  }

  /** 收集一条 SSE 流的全部分块，直到收到 end。 */
  async collectStream(path: string, timeoutMs = 30000): Promise<{ frame: Frame; text: string; ended: boolean }> {
    const id = `s${++this.seq}`;
    const chunks: Buffer[] = [];
    let ended = false;

    const done = new Promise<void>((resolveDone, rejectDone) => {
      const timer = setTimeout(() => {
        this.streamHandlers.delete(id);
        rejectDone(new Error(`SSE 超时：${path}`));
      }, timeoutMs);
      timer.unref?.();

      this.streamHandlers.set(id, (kind, body) => {
        if (kind === 'chunk') {
          chunks.push(body);
          return;
        }
        ended = true;
        clearTimeout(timer);
        this.streamHandlers.delete(id);
        resolveDone();
      });
    });

    this.send({ id, method: 'GET', path, headers: {}, bodyLength: 0 });
    await done;

    return {
      frame: this.streamHeaders.get(id) ?? {},
      text: Buffer.concat(chunks).toString('utf8'),
      ended,
    };
  }

  async waitForExit(timeoutMs = 15000): Promise<number | null> {
    if (this.exited) return this.exitCode;
    return new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error('进程未在预期时间内退出')), timeoutMs);
      this.child.once('exit', (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
  }

  kill(): void {
    if (!this.exited) this.child.kill();
  }
}

// ---------------------------------------------------------------- 断言

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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时`)), ms)),
  ]);
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'scoop-ipc-selftest-'));
  console.log(`\nIPC 协议自测\n  目标      ${TARGET}${IS_EXECUTABLE ? '（编译产物）' : '（源码）'}\n  数据目录  ${home}\n`);

  const client = new IpcClient(TARGET, IS_EXECUTABLE, home);

  try {
    // ---- 1. ready
    let ready: Frame;
    try {
      ready = await withTimeout(client.ready, 25000, 'ready 帧');
    } catch (error) {
      console.error(`\n无法建立 IPC 通道：${(error as Error).message}`);
      console.error('--- stderr ---\n' + client.stderr);
      client.kill();
      process.exit(1);
    }
    check(`ready 帧到达且 schema=${EXPECTED_SCHEMA}`, ready.schema === EXPECTED_SCHEMA, `实际 schema=${String(ready.schema)}`);

    // ---- 2. health
    const health = await client.request('GET', '/api/health');
    check('/api/health 返回 200', health.status === 200, `status=${health.status}`);
    check('health.transport === "ipc"', health.json?.data?.transport === 'ipc', String(health.json?.data?.transport));
    check('health.server.port === 0（未监听端口）', health.json?.data?.server?.port === 0, String(health.json?.data?.server?.port));

    // ---- 3. 纯内存接口
    const keys = await client.request('GET', '/api/config/keys');
    check('/api/config/keys 返回 200', keys.status === 200, `status=${keys.status}`);
    check('/api/config/keys 是合法 JSON 信封', keys.json?.ok === true, JSON.stringify(keys.json)?.slice(0, 160));
    check('响应体非空（body 路径生效）', keys.body.length > 20, `${keys.body.length} 字节`);

    // ---- 4. query string
    const jobs = await client.request('GET', '/api/jobs?limit=1');
    check('/api/jobs?limit=1 返回 200（query string 解析正常）', jobs.status === 200, `status=${jobs.status}`);
    check('/api/jobs 返回 items 数组', Array.isArray(jobs.json?.data?.items), JSON.stringify(jobs.json)?.slice(0, 160));

    // ---- 5. 404
    const missing = await client.request('GET', '/api/__definitely_missing__');
    check('未匹配接口返回 404', missing.status === 404, `status=${missing.status}`);
    check('404 为 JSON 错误信封', missing.json?.ok === false, JSON.stringify(missing.json)?.slice(0, 160));

    // ---- 6. SSE
    const created = await client.request('POST', '/api/apps/status', {});
    const jobId = created.json?.data?.job?.id;
    check(
      'POST /api/apps/status 返回 202 与任务 id',
      created.status === 202 && typeof jobId === 'string',
      `status=${created.status} id=${String(jobId)}`,
    );

    if (typeof jobId === 'string') {
      const stream = await client.collectStream(`/api/jobs/${encodeURIComponent(jobId)}/events?since=0`);
      check(
        'SSE 响应头帧带 stream=true 且 content-type 正确',
        stream.frame.stream === true && (stream.frame.headers?.['content-type'] ?? '').includes('text/event-stream'),
        `stream=${String(stream.frame.stream)} ct=${String(stream.frame.headers?.['content-type'])}`,
      );
      check('SSE 收到分块', stream.text.length > 0, `${stream.text.length} 字节`);
      check('SSE 收到结束帧', stream.ended);
      check('SSE 分块为合法 SSE 文本', stream.text.includes('event:'), stream.text.slice(0, 120).replace(/\n/g, '\\n'));

      // 收尾：若本机装了 Scoop，这个任务可能仍在跑，立即取消避免留下副作用
      await client.request('POST', `/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
    }

    // ---- 7. 优雅退出
    client.send({ type: 'shutdown' });
    const code = await client.waitForExit(15000);
    check('shutdown 控制帧触发优雅退出（退出码 0）', code === 0, `exitCode=${String(code)}`);

    // ---- 8. 洁净性
    check('stdout 中无任何非协议文本', client.noise.length === 0, client.noise.join(' | ').slice(0, 300));
    check('退出后无残留半个帧', client.leftover === 0, `残留 ${client.leftover} 字节`);
    check('日志已全部改走 stderr', client.stderr.includes('[desktop]'), client.stderr.slice(0, 200).replace(/\n/g, ' '));
  } catch (error) {
    failures.push(String((error as Error).message));
    console.error(`\n自测中断：${(error as Error).message}`);
    console.error('--- 子进程 stderr 末尾 ---\n' + client.stderr.split('\n').slice(-15).join('\n'));
    client.kill();
  } finally {
    client.kill();
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // 临时目录删不掉不影响结论
    }
  }

  console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length > 0) {
    console.log('\n失败明细：');
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
  console.log('IPC 协议自测全部通过。\n');
}

void main();
