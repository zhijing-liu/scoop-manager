/**
 * ScoopClient —— 高层操作能力层。
 *
 * 职责：把 buildFlags(run, options) 这种 boilerplate 收敛成语义化的方法，
 * 调用方（Hono 路由、桌面壳、CLI 工具）只需说"装这些 apps"，不用关心：
 *   - 官方 getopt 是什么
 *   - run() 的 cancelRequested / setCancelHandler 怎么注入
 *   - 需要等多久（每个命令都有合理默认超时）
 *   - 是串行还是并行（只读命令自动并行）
 *
 * 这是 scoop-core 对外的主入口之一（另一个是 runner.run 给需要完全自定义的场景）。
 * 新接入方优先用 ScoopClient，底层能力不够时再直接用 runner / 其它模块。
 */

import { run, type RunOptions, type RunResult } from './runner.js';
import { buildFlags, CLEANUP, DOWNLOAD, HOLD, INSTALL, RESET, UNINSTALL, UPDATE, type ScoopCommandDef } from './options.js';
import type { OutputStream } from './runner.js';

// ---------------------------------------------------------------------- 选项类型（对每个命令暴露最小字段集合）

export interface InstallOptions {
  global?: boolean;
  independent?: boolean;
  skipHash?: boolean;
  noCache?: boolean;
  noUpdateScoop?: boolean;
  /** 留空表示自动 */
  arch?: '64bit' | '32bit' | 'arm64' | '' | null;
}

export interface UpdateOptions {
  global?: boolean;
  force?: boolean;
  independent?: boolean;
  noCache?: boolean;
  skipHash?: boolean;
  quiet?: boolean;
}

export interface UninstallOptions {
  global?: boolean;
  /** 连同 persistent 用户数据一起删 */
  purge?: boolean;
}

export interface HoldOptions {
  global?: boolean;
}

export interface CleanupOptions {
  global?: boolean;
  /** 同时清理过期下载缓存（scoop cleanup -k） */
  cache?: boolean;
}

export interface DownloadOptions {
  force?: boolean;
  skipHash?: boolean;
  noUpdateScoop?: boolean;
  arch?: '64bit' | '32bit' | 'arm64' | '' | null;
}

// ---------------------------------------------------------------------- 可插拔的运行时钩子

/** 调用方在 RunOptions 上覆盖的字段都会被透传。 */
export type RunHook = (defaults: RunOptions) => RunOptions | Promise<RunOptions>;

export interface ScoopClientOptions {
  /** 可选：统一的 label 前缀（例如"scoop-manager"） */
  labelPrefix?: string;
  /** 可选：在每次 run() 前改写 RunOptions（最常见用途是注入 cancelRequested / setCancelHandler） */
  hookRun?: RunHook;
}

// ---------------------------------------------------------------------- 构建

function toFlags(def: ScoopCommandDef, options: Record<string, unknown>): string[] {
  return buildFlags(def, options);
}

function archOrNull(v: InstallOptions['arch'] | DownloadOptions['arch']): string | null {
  if (!v) return null;
  return v;
}

async function runScoop(
  literal: string,
  args: string[],
  label: string,
  defaultTimeoutMs: number,
  serial = true,
  extra: Partial<RunOptions> = {},
  hookRun?: RunHook,
): Promise<RunResult> {
  const base: RunOptions = {
    label,
    args,
    serial,
    timeoutMs: defaultTimeoutMs,
    ...extra,
  };
  const final = hookRun ? await hookRun(base) : base;
  // 如果 hook 没有注入 args（外部可能只想注入 cancel），把 literal 作为命令提示写进日志
  if (!final.label || final.label === 'Scoop 命令') final.label = label;
  return run(final);
}

// ---------------------------------------------------------------------- 公共接口

export class ScoopClient {
  constructor(private readonly opts: ScoopClientOptions = {}) {}

  // --- 应用命令（serial=true，变更磁盘，必须串行） ---

  async install(apps: string[], options: InstallOptions = {}, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const opts = {
      global: options.global ?? false,
      independent: options.independent ?? false,
      skipHash: options.skipHash ?? false,
      noCache: options.noCache ?? false,
      noUpdateScoop: options.noUpdateScoop ?? false,
      arch: archOrNull(options.arch),
    };
    const args = ['install', ...toFlags(INSTALL, opts), ...apps];
    return runScoop('install', args, `${this.opts.labelPrefix ?? ''} scoop install ${apps.join(', ')}`.trim(), 30 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  async uninstall(apps: string[], options: UninstallOptions = {}, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const opts = {
      global: options.global ?? false,
      purge: options.purge ?? false,
    };
    const args = ['uninstall', ...toFlags(UNINSTALL, opts), ...apps];
    return runScoop('uninstall', args, `${this.opts.labelPrefix ?? ''} scoop uninstall ${apps.join(', ')}`.trim(), 15 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  async update(apps: string[] | '*', options: UpdateOptions = {}, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const opts = {
      global: options.global ?? false,
      force: options.force ?? false,
      independent: options.independent ?? false,
      noCache: options.noCache ?? false,
      skipHash: options.skipHash ?? false,
      quiet: options.quiet ?? false,
    };
    const names = apps === '*' ? ['*'] : apps;
    const args = ['update', ...toFlags(UPDATE, opts), ...names];
    const label = apps === '*' ? 'scoop update *' : `scoop update ${apps.join(', ')}`;
    return runScoop('update', args, label, apps === '*' ? 60 * 60 * 1000 : 30 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  async hold(apps: string[], options: HoldOptions = {}, hold = true, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const opts = { global: options.global ?? false };
    const literal = hold ? 'hold' : 'unhold';
    const args = [literal, ...toFlags(HOLD, opts), ...apps];
    return runScoop(literal, args, `scoop ${literal} ${apps.join(', ')}`, 5 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  async unhold(apps: string[], options: HoldOptions = {}, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    return this.hold(apps, options, false, extra);
  }

  async reset(apps: string[], extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const args = ['reset', ...apps];
    return runScoop('reset', args, `scoop reset ${apps.join(', ')}`, 15 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  async cleanup(apps: string[] | '*', options: CleanupOptions = {}, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const opts = {
      global: options.global ?? false,
      cache: options.cache ?? false,
    };
    const names = apps === '*' ? ['*'] : apps;
    const args = ['cleanup', ...toFlags(CLEANUP, opts), ...names];
    const label = apps === '*' ? `scoop cleanup ${opts.cache ? '-k ' : ''}*` : `scoop cleanup ${opts.cache ? '-k ' : ''}${apps.join(', ')}`;
    return runScoop('cleanup', args, label, 15 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  async download(apps: string[], options: DownloadOptions = {}, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const opts = {
      force: options.force ?? false,
      skipHash: options.skipHash ?? false,
      noUpdateScoop: options.noUpdateScoop ?? false,
      arch: archOrNull(options.arch),
    };
    const args = ['download', ...toFlags(DOWNLOAD, opts), ...apps];
    return runScoop('download', args, `scoop download ${apps.join(', ')}`, 30 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  // --- Scoop 自身维护命令（serial=false，Scoop 自身命令不需要和应用操作互斥） ---

  async checkup(extra: Partial<RunOptions> = {}): Promise<RunResult> {
    return runScoop('checkup', ['checkup'], 'scoop checkup', 5 * 60 * 1000, false, extra, this.opts.hookRun);
  }

  async selfUpdate(extra: Partial<RunOptions> = {}): Promise<RunResult> {
    return runScoop('self-update', ['update'], 'scoop update', 15 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  /**
   * 卸载 Scoop 自身：scoop uninstall [-g][-p] scoop。
   * purge=true 会同时删除 persistent 目录（不可恢复）。
   */
  async uninstallScoop(options: { global?: boolean; purge?: boolean } = {}, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const flags: string[] = [];
    if (options.global) flags.push('-g');
    if (options.purge) flags.push('-p');
    const args = ['uninstall', ...flags, 'scoop'];
    return runScoop('uninstall-scoop', args, `scoop uninstall ${flags.join(' ')} scoop`.trim(), 15 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  // --- 缓存（走 cache rm） ---

  async cacheRm(target?: string | null, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const args = target ? ['cache', 'rm', target] : ['cache', 'rm', '*'];
    return runScoop('cache-rm', args, target ? `scoop cache rm ${target}` : 'scoop cache rm *', 10 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  // --- Scoopfile ---

  async importScoopfile(filePath: string, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    return runScoop('import', ['import', filePath], `scoop import ${filePath}`, 60 * 60 * 1000, true, extra, this.opts.hookRun);
  }

  /** 原始命令入口：不想绕 ScoopClient 或未来有新命令时直接透传 args。 */
  async raw(args: string[], label?: string, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    return runScoop('raw', args, label ?? args.join(' '), 30 * 60 * 1000, extra.serial ?? true, extra, this.opts.hookRun);
  }
}

// 也导出类型，方便调用方写参数对象时获得 IDE 补全
export type { OutputStream };
