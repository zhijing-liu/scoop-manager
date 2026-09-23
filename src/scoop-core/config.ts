/**
 * Scoop 配置管理。
 *
 * 读取：直接解析 config.json。不同 Scoop 版本的配置文件位置不同
 *       （`~/.config/scoop/config.json`、`$SCOOP/config.json`、或 `$SCOOP_CONFIG_HOME`），
 *       所以这里做运行时探测，绝不写死路径。
 * 写入：一律通过 `scoop config <key> <value>` / `scoop config rm <key>`，
 *       借助 Scoop 自身的校验与落盘逻辑，避免直接改文件导致格式不一致。
 */

import { dirname, join } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { exists, readJson } from '../utils/fsx.js';
import { isProxyValue, assertProxyValue } from '../utils/validate.js';
import { AppError } from './errors.js';
import { detectScoop } from './locator.js';
import { parseProxyTarget, testTcp, type TcpTestResult } from '../utils/net.js';

export type ProxyMode = 'custom' | 'system' | 'none';

export interface ConfigEntry {
  key: string;
  value: unknown;
  /** 是否可能包含凭据，前端默认打码 */
  sensitive: boolean;
}

export interface ScoopConfigSnapshot {
  file: string | null;
  exists: boolean;
  writable: boolean;
  entries: ConfigEntry[];
  proxy: {
    value: string | null;
    mode: ProxyMode;
  };
  /** 提示信息，例如配置文件不可写 */
  notes: string[];
}

/** 可能含凭据的键 */
const SENSITIVE_KEYS = new Set(['proxy', 'gh_token', 'token', 'password', 'github_token']);

function isSensitive(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase()) || /token|password|secret/i.test(key);
}

function isWritable(target: string): boolean {
  try {
    if (exists(target)) {
      accessSync(target, constants.W_OK);
      return true;
    }
    accessSync(dirname(target), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 探测配置文件位置（与 scoop-locator 保持一致，但允许在未安装时返回候选路径）。 */
export async function resolveConfigFile(): Promise<{ file: string | null; detected: boolean }> {
  const env = await detectScoop();
  if (env.configFile) {
    return { file: env.configFile, detected: exists(env.configFile) };
  }

  const configHome = process.env['SCOOP_CONFIG_HOME'];
  const userDir = join(homedir(), '.config', 'scoop');
  const candidates = [
    configHome ? join(configHome, 'scoop', 'config.json') : null,
    join(userDir, 'config.json'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (exists(candidate)) return { file: candidate, detected: true };
  }
  return { file: candidates[1] ?? null, detected: false };
}

export async function readConfig(): Promise<ScoopConfigSnapshot> {
  const { file, detected } = await resolveConfigFile();
  const notes: string[] = [];

  if (!file) {
    return { file: null, exists: false, writable: false, entries: [], proxy: { value: null, mode: 'none' }, notes: ['未能确定 Scoop 配置文件位置。'] };
  }

  const raw = detected ? readJson<Record<string, unknown>>(file) : null;
  if (detected && raw === null) {
    notes.push('配置文件存在但无法解析（可能不是合法 JSON），已按空配置展示。');
  }

  const values = raw ?? {};
  const entries: ConfigEntry[] = Object.keys(values)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ key, value: values[key], sensitive: isSensitive(key) }));

  const proxyValue = typeof values['proxy'] === 'string' ? values['proxy'] : null;
  const writable = isWritable(file);
  if (!writable) {
    notes.push('当前配置文件不可写，修改配置可能失败（请检查文件权限）。');
  }
  if (!detected) {
    notes.push('配置文件尚未创建，首次设置任意配置项时会自动生成。');
  }

  return {
    file,
    exists: detected,
    writable,
    entries,
    proxy: { value: proxyValue, mode: proxyModeOf(proxyValue) },
    notes,
  };
}

export function proxyModeOf(value: string | null): ProxyMode {
  if (!value) return 'none';
  if (value.toLowerCase() === 'current') return 'system';
  if (value.toLowerCase() === 'none') return 'none';
  return 'custom';
}

export interface ProxyStatus {
  value: string | null;
  mode: ProxyMode;
  /** 供前端展示的脱敏地址 */
  display: string | null;
}

export function describeProxy(value: string | null): ProxyStatus {
  const mode = proxyModeOf(value);
  let display: string | null = value;
  if (value && mode === 'custom') {
    display = value.replace(/(:)[^:@/]+(@)/, '$1***$2');
  }
  if (mode === 'system') display = '跟随系统代理设置（current）';
  if (mode === 'none') display = null;
  return { value, mode, display };
}

/** 代理连通性测试：仅做 TCP 握手，不发送业务数据。 */
export async function testProxy(value: string | null, timeoutMs = 5000): Promise<TcpTestResult & { target: string | null; hint: string }> {
  if (!value || value === 'none') {
    return { ok: false, ms: 0, error: '当前未配置代理', target: null, hint: '请先设置一个代理地址再测试。' };
  }
  if (value === 'current') {
    return {
      ok: false,
      ms: 0,
      error: '当前为「跟随系统代理」模式',
      target: null,
      hint: '该模式使用 Windows 系统代理设置，本工具无法直接测试，请在系统设置中确认代理可用。',
    };
  }

  const target = parseProxyTarget(value);
  if (!target) {
    return { ok: false, ms: 0, error: '无法解析代理地址', target: null, hint: '请检查代理地址格式，例如 127.0.0.1:7890。' };
  }

  const result = await testTcp(target.host, target.port, timeoutMs);
  return {
    ...result,
    target: `${target.host}:${target.port}`,
    hint: result.ok ? '代理端口可连通。' : '代理端口不可达，请确认代理软件已启动且端口正确。',
  };
}

export interface ConfigKeyMeta {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'number' | 'string';
  /** 建议值，前端做快捷开关 */
  suggestion?: string;
}

/** 常用配置项参考列表（非穷举，Scoop 的键会随版本增减）。 */
export const COMMON_CONFIG_KEYS: ConfigKeyMeta[] = [
  { key: 'proxy', label: '代理', description: '下载时使用的代理，例如 127.0.0.1:7890，或 current / none', type: 'string' },
  { key: 'aria2-enabled', label: '启用 aria2 多线程下载', description: '显著提升下载速度，需要先安装 aria2', type: 'boolean', suggestion: 'true' },
  { key: 'aria2-warning-enabled', label: 'aria2 警告提示', description: '是否显示 aria2 的警告信息', type: 'boolean', suggestion: 'false' },
  { key: 'aria2-retry-wait', label: 'aria2 重试间隔（秒）', description: '下载失败后的重试等待时间', type: 'number', suggestion: '2' },
  { key: 'aria2-split', label: 'aria2 分片数', description: '单文件下载的分片数量', type: 'number', suggestion: '5' },
  { key: 'aria2-max-connection-per-server', label: 'aria2 单服务器最大连接数', description: '并发连接数上限', type: 'number', suggestion: '5' },
  { key: 'aria2-min-split-size', label: 'aria2 最小分片大小', description: '例如 5M', type: 'string', suggestion: '5M' },
  { key: 'cache-path', label: '下载缓存目录', description: '自定义缓存位置（建议与 scoop 同盘）', type: 'string' },
  { key: 'use-external-7zip', label: '使用外部 7zip', description: '使用独立的 7zip 解压，兼容性更好', type: 'boolean', suggestion: 'true' },
  { key: 'use-lessmsi', label: '使用 lessmsi 解包', description: '替代 msiexec 解包 MSI，可避免弹窗', type: 'boolean', suggestion: 'true' },
  { key: 'default-architecture', label: '默认架构', description: '64bit / 32bit / arm64', type: 'string', suggestion: '64bit' },
  { key: 'ignore_running_processes', label: '忽略运行中的进程', description: '更新时忽略进程占用（谨慎开启）', type: 'boolean', suggestion: 'false' },
  { key: 'gh_token', label: 'GitHub Token', description: '提高 GitHub API 速率限制', type: 'string' },
  { key: 'no-junction', label: '不使用 junction', description: '改用复制代替链接，兼容性更差但更安全', type: 'boolean', suggestion: 'false' },
];

/** 构造 `scoop config key value` 的 argv。 */
export function buildSetArgs(key: string, rawValue: unknown): string[] {
  if (key.toLowerCase() === 'proxy') {
    return ['config', 'proxy', assertProxyValue(rawValue)];
  }
  return ['config', key, serializeValue(rawValue)];
}

export function serializeValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) throw new AppError('INVALID_PARAM', '配置值不能为空。');
  try {
    return JSON.stringify(value);
  } catch {
    throw new AppError('INVALID_PARAM', '无法序列化该配置值。');
  }
}

export function buildRemoveArgs(key: string): string[] {
  return ['config', 'rm', key];
}

export function validateProxyInput(value: unknown): string {
  if (!isProxyValue(value)) {
    throw new AppError('INVALID_PARAM', '代理地址格式不合法。');
  }
  return String(value).trim();
}
