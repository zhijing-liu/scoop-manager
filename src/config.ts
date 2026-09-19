/**
 * 应用自身的配置（与 scoop 的 config 无关）。
 *
 * 存放位置：`%USERPROFILE%\.scoop-manager\config.json`
 * 刻意不放在 exe 同级目录 —— 用户很可能把 exe 放进 Program Files 或只读目录，
 * 那里没有写权限。数据目录可用环境变量 SCOOP_MANAGER_HOME 覆盖。
 */

import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import { ensureDir, readJson, writeJson } from './utils/fsx.js';
import { createLogger } from './utils/logger.js';
import { normalizeBasePath } from './utils/paths.js';

const logger = createLogger('config');

export const APP_NAME = 'scoop-manager';
export const APP_VERSION = '1.0.0';
export const APP_DESCRIPTION = 'Scoop 的 Web GUI 管理器';

export const DATA_DIR = normalize(process.env['SCOOP_MANAGER_HOME'] ?? join(homedir(), '.scoop-manager'));
export const CONFIG_FILE = join(DATA_DIR, 'config.json');
export const JOBS_FILE = join(DATA_DIR, 'jobs.json');

export interface AppConfig {
  /** 用户指定的 scoop 根目录（优先级高于环境变量） */
  scoopPath: string | null;
  /** 用户指定的全局 scoop 根目录 */
  scoopGlobalPath: string | null;
  /** 监听端口 */
  port: number;
  /** 监听地址，默认仅本机 */
  host: string;
  /** 启动后是否自动打开浏览器 */
  openBrowser: boolean;
  /** 启动时注入到 PowerShell 的额外 PATH 前缀（留作扩展） */
  extraPath: string | null;
  /**
   * 本程序自带的代理设置（`current` / `none` / host:port / http://user:pass@host:port）。
   *
   * 存在的意义是「先有鸡还是先有蛋」：`scoop config proxy` 只有在 Scoop 装好之后
   * 才可用，而**安装 Scoop 恰恰是最需要代理的一步**（要从 get.scoop.sh 拉脚本、
   * 再从 GitHub 克隆 bucket）。所以本程序自己也存一份，安装时注入到子进程环境
   * 与 PowerShell 会话中；Scoop 装好后由安装流程同步进 scoop config。
   */
  proxy: string | null;
  /**
   * 反向代理子路径。留空表示部署在根路径。
   *
   * 设为 '/scoop' 时，服务会同时接受 '/scoop/...' 与不带前缀的请求
   * （即「代理透传前缀」与「代理剥离前缀」两种配置都能工作），
   * 并在返回的 index.html 中注入该前缀，让前端把接口与静态资源指向正确位置。
   */
  basePath: string;
}

const DEFAULTS: AppConfig = {
  scoopPath: null,
  scoopGlobalPath: null,
  port: 3000,
  host: '127.0.0.1',
  openBrowser: true,
  extraPath: null,
  proxy: null,
  basePath: '',
};

let current: AppConfig = { ...DEFAULTS };
let loaded = false;

function coerce(raw: Partial<AppConfig> | null): AppConfig {
  const merged = { ...DEFAULTS, ...(raw ?? {}) };
  return {
    scoopPath: typeof merged.scoopPath === 'string' && merged.scoopPath.length > 0 ? normalize(merged.scoopPath) : null,
    scoopGlobalPath:
      typeof merged.scoopGlobalPath === 'string' && merged.scoopGlobalPath.length > 0 ? normalize(merged.scoopGlobalPath) : null,
    port: Number.isFinite(merged.port) ? Math.min(65535, Math.max(1, Math.trunc(merged.port))) : DEFAULTS.port,
    host: typeof merged.host === 'string' && merged.host.length > 0 ? merged.host : DEFAULTS.host,
    openBrowser: merged.openBrowser !== false,
    extraPath: typeof merged.extraPath === 'string' && merged.extraPath.length > 0 ? merged.extraPath : null,
    proxy: typeof merged.proxy === 'string' && merged.proxy.trim().length > 0 ? merged.proxy.trim() : null,
    basePath: normalizeBasePath(merged.basePath),
  };
}

export function ensureDataDir(): void {
  ensureDir(DATA_DIR);
}

export function loadAppConfig(): AppConfig {
  ensureDataDir();
  const raw = readJson<Partial<AppConfig>>(CONFIG_FILE);
  current = coerce(raw);
  loaded = true;
  return current;
}

export function getAppConfig(): AppConfig {
  if (!loaded) loadAppConfig();
  return current;
}

/**
 * 应用配置变更。
 *
 * persist = false 时只更新进程内状态，不写回 config.json —— 桌面端外壳需要临时
 * 覆盖 host / port 等值，但不能污染用户为 pm2 或反向代理准备的那份配置。
 *
 * 注意作用范围：本机制只影响「CLI 覆盖」的落盘。UI 通过 /api/scoop/path 等接口
 * 做的修改照常走 saveAppConfig（persist 默认 true），不受 --no-persist 影响。
 */
export function applyAppConfig(patch: Partial<AppConfig>, options: { persist?: boolean } = {}): AppConfig {
  if (!loaded) loadAppConfig();
  current = coerce({ ...current, ...patch });
  if (options.persist === false) return current;

  ensureDataDir();
  writeJson(CONFIG_FILE, current);
  logger.info(`应用配置已更新: ${CONFIG_FILE}`);
  return current;
}

export function saveAppConfig(patch: Partial<AppConfig>): AppConfig {
  return applyAppConfig(patch, { persist: true });
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

/** 解析命令行参数 */
export interface CliOptions {
  port?: number;
  host?: string;
  openBrowser?: boolean;
  scoopPath?: string;
  basePath?: string;
  logLevel?: string;
  /**
   * 传输模式。缺省（undefined）走 HTTP 服务模式；
   * `stdio` 表示桌面端 IPC 模式 —— 通过 stdin/stdout 分帧通信，不监听任何端口。
   */
  rpc?: string;
  /** 桌面端传入的父进程 PID，父进程退出后本进程自动关闭 */
  parentPid?: number;
  /** false 表示 CLI 覆盖只在本次进程内生效，不写回 config.json */
  persist?: boolean;
  help: boolean;
  version: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw) continue;
    const [flag, inlineValue] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const next = (): string | undefined => inlineValue ?? argv[i + 1];

    switch (flag) {
      case '-p':
      case '--port': {
        const value = next();
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) options.port = parsed;
        if (inlineValue === undefined) i += 1;
        break;
      }
      case '--host': {
        const value = next();
        if (value) options.host = value;
        if (inlineValue === undefined) i += 1;
        break;
      }
      case '--scoop-path':
      case '--scoop': {
        const value = next();
        if (value) options.scoopPath = value;
        if (inlineValue === undefined) i += 1;
        break;
      }
      case '--base-path':
      case '--basepath':
      case '--base': {
        const value = next();
        if (value) options.basePath = value;
        if (inlineValue === undefined) i += 1;
        break;
      }
      case '--log-level': {
        const value = next();
        if (value) options.logLevel = value;
        if (inlineValue === undefined) i += 1;
        break;
      }
      case '--rpc': {
        const value = next();
        if (value) options.rpc = value;
        if (inlineValue === undefined) i += 1;
        break;
      }
      case '--parent-pid': {
        const value = next();
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (Number.isFinite(parsed) && parsed > 0) options.parentPid = parsed;
        if (inlineValue === undefined) i += 1;
        break;
      }
      case '--no-persist':
        options.persist = false;
        break;
      case '--open':
        options.openBrowser = true;
        break;
      case '--no-open':
        options.openBrowser = false;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      default:
        break;
    }
  }
  return options;
}

export function helpText(): string {
  return [
    `${APP_NAME} v${APP_VERSION} - ${APP_DESCRIPTION}`,
    '',
    '用法: scoop-manager [选项]',
    '',
    '选项:',
    '  -p, --port <端口>        监听端口（默认 3000；被占用时自动向后寻找）',
    '      --host <地址>        监听地址（默认 127.0.0.1）',
    '      --scoop-path <路径>  手动指定 scoop 根目录（会写入应用配置）',
    '      --base-path <路径>   反向代理子路径，例如 /scoop（默认部署在根路径）',
    '      --log-level <级别>   debug | info | warn | error（默认 info）',
    '      --open               启动后自动打开浏览器（默认行为）',
    '      --no-open            启动后不打开浏览器',
    '      --rpc <模式>         传输模式；stdio 表示走 stdin/stdout 且不监听端口（桌面端专用）',
    '      --parent-pid <pid>   父进程 PID；父进程退出后本进程自动关闭（桌面端专用）',
    '      --no-persist         本次 CLI 覆盖不写回配置文件（桌面端专用）',
    '  -v, --version            显示版本号',
    '  -h, --help               显示本帮助',
    '',
    `数据目录: ${DATA_DIR}`,
  ].join('\n');
}
