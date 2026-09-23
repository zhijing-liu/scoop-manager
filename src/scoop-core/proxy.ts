/**
 * 代理设置的统一入口。
 *
 * 之所以需要两份存储，是因为存在一个「先有鸡还是先有蛋」的问题：
 *
 *   - Scoop 装好之后，代理理所当然写在 `scoop config proxy`，Scoop 自己会读；
 *   - 但 **安装 Scoop 恰恰是最需要代理的一步** —— 要先从 get.scoop.sh 拉安装脚本，
 *     再从 GitHub 克隆 main bucket，而此时 `scoop config` 根本不存在。
 *
 * 因此本程序自己也存一份代理（应用配置里的 proxy 字段）。规则很简单：
 *
 *   - Scoop 已安装   -> 读 / 写都走 scoop config（本程序的值仅作历史留存）
 *   - Scoop 未安装   -> 读 / 写都走本程序，并在安装 Scoop 时注入到子进程环境
 *
 * 注入方式是**进程级**的（环境变量 + PowerShell 会话内的 DefaultWebProxy），
 * 不修改系统代理设置、也不改 git 全局配置，避免留下用户不知情的副作用。
 */

import { getAppConfig, saveAppConfig } from '../config.js';
import { describeProxy, readConfig, type ProxyStatus } from './config.js';
import { detectScoop } from './locator.js';
import { createLogger } from './logger.js';

const logger = createLogger('proxy');

/** 代理值的来源：`scoop`（scoop config）/ `manager`（本程序）/ `none`（未设置） */
export type ProxySource = 'scoop' | 'manager' | 'none';

export interface EffectiveProxy extends ProxyStatus {
  source: ProxySource;
  /** Scoop 是否已安装；决定前端展示哪套说明文案、写入走哪条路径 */
  scoopInstalled: boolean;
}

/**
 * 读取当前生效的代理。
 *
 * 注意顺序：Scoop 一旦装好就以 scoop config 为准（否则两边不一致会很困惑）；
 * 没装时才回落到本程序自己的配置。
 */
export async function readEffectiveProxy(): Promise<EffectiveProxy> {
  const [env, snapshot] = await Promise.all([detectScoop(), readConfig()]);

  if (env.installed) {
    const value = snapshot.proxy.value;
    return { ...describeProxy(value), source: value ? 'scoop' : 'none', scoopInstalled: true };
  }

  const manager = getManagerProxy();
  return { ...describeProxy(manager), source: manager ? 'manager' : 'none', scoopInstalled: false };
}

/** 本程序自己保存的代理（与 scoop config 无关）。 */
export function getManagerProxy(): string | null {
  return getAppConfig().proxy ?? null;
}

/** 写入 / 清除本程序自己的代理。传入 null 或 'none' 表示清除。 */
export function setManagerProxy(value: string | null): string | null {
  const next = value && value.trim().length > 0 && value.trim().toLowerCase() !== 'none' ? value.trim() : null;
  saveAppConfig({ proxy: next });
  logger.info(next ? `本程序代理已更新: ${next}` : '本程序代理已清除');
  return next;
}

/**
 * 把 scoop 风格的代理值归一化为带协议的 URL。
 *
 * `127.0.0.1:7890` -> `http://127.0.0.1:7890`；
 * 已经是 http(s):// 的保持原样，以便保留 user:pass@ 凭据。
 * `current` / `none` 无法作为 URL 使用，返回 null（由调用方另作处理）。
 */
export function normalizeProxyUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'none' || lower === 'current') return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/**
 * 构造注入子进程的环境变量。
 *
 * 同时给大写与小写两种写法（不同工具认的不一样）：
 *   - git / aria2 / curl 读 http_proxy / https_proxy
 *   - PowerShell 7+ 的 Invoke-RestMethod（.NET HttpClient）读 HTTP_PROXY / HTTPS_PROXY
 */
export function buildProxyEnv(value: string | null | undefined): Record<string, string> {
  const url = normalizeProxyUrl(value);
  if (!url) return {};
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
  };
}

/**
 * 构造 PowerShell 会话内启用代理的前置语句。
 *
 * Windows PowerShell 5.1 的 Invoke-RestMethod 走 .NET Framework 的 WebRequest，
 * 只认 `WebRequest.DefaultWebProxy`（默认取自 IE/系统设置），**不认环境变量**。
 * 而安装脚本内部正是用 Invoke-RestMethod 拉 get.scoop.sh 的，所以必须补这一段。
 * 赋值只在当前 PowerShell 进程内有效，退出即消失。
 *
 * @param quotedValue 已经过 psQuote 转义的、待插入单引号字符串位置的表达式
 */
export function buildProxyPreamble(quotedExpression: string): string {
  return `try { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy(${quotedExpression}) } catch { }`;
}

/** 是否为「可直接用于下载的自定义代理」（排除 current / none）。 */
export function isUsableProxy(value: string | null | undefined): boolean {
  return normalizeProxyUrl(value) !== null;
}
