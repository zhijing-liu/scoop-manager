/**
 * 进程级运行时状态。
 *
 * 与 config.ts 的区别：config 是"用户偏好"（要落盘），runtime 是"本次进程的
 * 实际状态"（端口可能因为占用而自动后移，不应该写回用户配置）。
 */

export type RuntimeKind = 'bun' | 'node';

/**
 * 传输模式。
 *
 * - `http`：服务模式。监听 TCP 端口，供浏览器 / 反向代理 / pm2 使用。
 * - `ipc` ：应用模式。桌面端（Tauri sidecar）通过 stdin/stdout 分帧通信，
 *           **不监听任何端口**。
 *
 * 业务内核（routes / services / jobs）不应读取本字段 —— 传输差异只允许出现在
 * src/modes/ 与 src/server/adapter.*.ts 两层，否则"两种模式彻底隔离"就失效了。
 */
export type TransportKind = 'http' | 'ipc';

/**
 * 安全获取 Bun 全局对象。
 *
 * 不能直接写 `Bun?.version`：在 Node 下 `Bun` 是「未声明的标识符」，
 * 可选链只会拦截 null/undefined，遇到未声明标识符仍会抛 ReferenceError，
 * 导致 Node 运行时一启动就崩。经 globalThis 访问则始终安全。
 */
export function bunRuntime(): BunGlobal | undefined {
  return (globalThis as unknown as { Bun?: BunGlobal }).Bun;
}

export interface RuntimeState {
  port: number;
  host: string;
  kind: RuntimeKind;
  /** 当前传输模式，供 /api/health 上报与排障 */
  transport: TransportKind;
  startedAt: number;
  /** 端口是否因为占用而发生过自动后移 */
  portShifted: boolean;
}

export const runtime: RuntimeState = {
  port: 0,
  host: '127.0.0.1',
  kind: bunRuntime()?.version ? 'bun' : 'node',
  transport: 'http',
  startedAt: Date.now(),
  portShifted: false,
};

export function setRuntime(patch: Partial<RuntimeState>): void {
  Object.assign(runtime, patch);
}

export function setTransport(transport: TransportKind): void {
  runtime.transport = transport;
}

export function runtimeLabel(): string {
  const bun = bunRuntime();
  return runtime.kind === 'bun' ? `bun ${bun?.version ?? ''}`.trim() : `node ${process.versions.node}`;
}
