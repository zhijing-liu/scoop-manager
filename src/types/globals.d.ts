/**
 * 局部声明 Bun 运行时全局对象的最小面。
 *
 * 刻意不引入 @types/bun：一旦引入，Bun 会覆盖大量 Node 类型定义，
 * 与 `types: ["node"]` 产生冲突，导致编译期噪音。
 *
 * ⚠️ 这里**故意不** `declare var Bun`：
 * Node 下 `Bun` 这个标识符根本不存在，`Bun?.x` 依然会抛 ReferenceError
 * （可选链只防 null/undefined，不防「未声明的标识符」）。如果声明了它，
 * 编译器就会放过这种写法，错误只能等到运行时才暴露。
 *
 * 因此访问 Bun 一律通过 `runtime.ts` 的 `bunRuntime()`（内部走 globalThis），
 * 并让 TS 在编译期拦住任何直接引用 `Bun` 的写法。
 */

interface BunEmbeddedFile {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface BunServeOptions {
  port: number;
  hostname?: string;
  fetch(request: Request): Response | Promise<Response>;
}

interface BunServerHandle {
  readonly port: number;
  readonly hostname: string;
  stop(closeActiveConnections?: boolean): void;
}

interface BunGlobal {
  version?: string;
  serve(options: BunServeOptions): BunServerHandle;
  readonly embeddedFiles?: ReadonlyArray<BunEmbeddedFile>;
  readonly isStandaloneExecutable?: boolean;
}

declare var Bun: BunGlobal | undefined;
