/**
 * 极简分级日志。
 *
 * 设计取舍：不引入 winston / pino 之类的日志库。本工具的日志只服务于
 * 本地开发与排障，分级 + 时间戳 + 标签已经足够，且能显著减小 exe 体积。
 *
 * 安全约定：绝不打印账号密码等敏感值；代理地址在输出前会做脱敏。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const COLOR: Record<LogLevel, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

const RESET = '\u001b[0m';
const DIM = '\u001b[90m';

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** 是否启用 ANSI 颜色：优先尊重 NO_COLOR，其次要求 stdout 是终端。 */
function useColor(): boolean {
  if (process.env['NO_COLOR']) return false;
  return process.stdout.isTTY === true;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 把任何值转成安全的单行文本，同时限制长度，避免把巨型 payload 打进终端。
 */
function format(value: unknown, maxLength = 600): string {
  let text: string;
  if (value === undefined) text = '';
  else if (value === null) text = 'null';
  else if (typeof value === 'string') text = value;
  else if (value instanceof Error) text = value.stack ?? `${value.name}: ${value.message}`;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s*\n\s*/g, ' ⏎ ');
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}… (${text.length} 字符)`;
  return text;
}

/** 对可能含凭据的 URL / 代理串做脱敏，形如 http://user:***@host:port。 */
export function redactSecret(text: string): string {
  return text.replace(/(\w+:\/\/[^:/\s@]+):[^@\s/]+@/g, '$1:***@');
}

function write(level: LogLevel, scope: string, message: unknown): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return;
  const colored = useColor();
  const tag = colored ? `${COLOR[level]}${level.toUpperCase().padEnd(5)}${RESET}` : level.toUpperCase().padEnd(5);
  const time = colored ? `${DIM}${stamp()}${RESET}` : stamp();
  const body = redactSecret(format(message));
  const line = `${time} ${tag} ${colored ? `${DIM}[${scope}]${RESET}` : `[${scope}]`} ${body}`;

  // IPC 模式（桌面端）下 stdout 是二进制协议通道：任何一行日志都会破坏帧边界。
  // 因此该模式下所有级别一律改走 stderr，由 Tauri 外壳落盘到 desktop.log。
  // 环境变量在 src/modes/desktop.ts 启动最早期设置，这里每次读取即可。
  const toStderr = level === 'error' || level === 'warn' || process.env['SCOOP_MANAGER_RPC'] === '1';
  const sink = toStderr ? process.stderr : process.stdout;
  sink.write(`${line}\n`);
}

export interface Logger {
  debug(message: unknown): void;
  info(message: unknown): void;
  warn(message: unknown): void;
  error(message: unknown): void;
  scope(name: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m) => write('debug', scope, m),
    info: (m) => write('info', scope, m),
    warn: (m) => write('warn', scope, m),
    error: (m) => write('error', scope, m),
    scope: (child) => createLogger(`${scope}:${child}`),
  };
}

export const log = createLogger('app');
