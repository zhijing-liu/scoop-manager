/**
 * Scoop 环境探测。
 *
 * 探测顺序（优先级从高到低）：
 *   1. 应用配置中用户手工指定的 scoopPath
 *   2. 环境变量 SCOOP
 *   3. scoop 自己的 config.json 中的 rootPath
 *   4. 默认目录 %USERPROFILE%\scoop
 *   5. 通过 `where.exe scoop` 反推（应对 scoop 装在非标准位置的情况）
 *
 * 每个候选都会做结构校验（存在 apps 目录），避免把随手的目录误判为 scoop 根。
 * 结果缓存 5 秒，避免每次请求都做磁盘探测。
 */

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { getAppConfig, isWindows, saveAppConfig } from '../config.js';
import { AppError } from './errors.js';
import { exists, isDirectory, listDirs, readJson, readText } from '../utils/fsx.js';
import { createLogger } from './logger.js';
import { findPowerShell, psQuote, runPowerShellOnce, type PowerShellKind } from './powershell.js';

const logger = createLogger('scoop');

export type ScoopRootSource = 'app-config' | 'env' | 'config-file' | 'default' | 'path' | null;

export interface ScoopEnvironment {
  platform: string;
  supported: boolean;
  installed: boolean;
  /** 当前生效的 scoop 根目录 */
  root: string | null;
  rootSource: ScoopRootSource;
  /** 全局（管理员）scoop 根目录 */
  globalRoot: string | null;
  shimsPath: string | null;
  appsPath: string | null;
  globalAppsPath: string | null;
  /** 主入口脚本 scoop.ps1 的绝对路径 */
  scriptPath: string | null;
  version: string | null;
  /** 安装通道：master = git 克隆安装（版本号取自 CHANGELOG），versioned = 版本化安装 */
  channel: 'master' | 'versioned' | null;
  configFile: string | null;
  /** scoop 自身是否被 hold */
  powershell: {
    path: string | null;
    kind: PowerShellKind | null;
    executionPolicy: string | null;
  };
  issues: string[];
  checkedAt: number;
}

let cachedEnv: ScoopEnvironment | null = null;
const CACHE_TTL_MS = 5000;

function safeNormalize(p: string): string {
  try {
    return normalize(p);
  } catch {
    return p;
  }
}

/** 结构校验：一个目录要被认为是 scoop 根，至少要有 apps 子目录。 */
function isValidScoopRoot(dir: string | null | undefined): boolean {
  if (!dir) return false;
  return isDirectory(join(dir, 'apps'));
}

/** 从 scoop 的 config.json 中读取 rootPath / globalPath。 */
function readScoopConfigHints(): { rootPath: string | null; globalPath: string | null; configFile: string | null } {
  const candidates = [
    process.env['SCOOP_CONFIG_HOME'] ? join(process.env['SCOOP_CONFIG_HOME'], 'scoop', 'config.json') : null,
    join(homedir(), '.config', 'scoop', 'config.json'),
    join(homedir(), 'scoop', 'config.json'),
  ].filter((value): value is string => Boolean(value));

  for (const file of candidates) {
    if (!exists(file)) continue;
    const raw = readJson<{ rootPath?: string; globalPath?: string }>(file);
    if (!raw) continue;
    return {
      rootPath: typeof raw.rootPath === 'string' ? safeNormalize(raw.rootPath) : null,
      globalPath: typeof raw.globalPath === 'string' ? safeNormalize(raw.globalPath) : null,
      configFile: file,
    };
  }
  return { rootPath: null, globalPath: null, configFile: null };
}

/** 通过 `where.exe scoop` 反推安装位置。 */
function findByPathLookup(): string | null {
  const whereExe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'where.exe');
  if (!exists(whereExe)) return null;
  try {
    const output = spawnSync(whereExe, ['scoop'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const lines = (output.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      const dir = dirname(line);
      if (dir.toLowerCase().endsWith('shims')) {
        const root = dirname(dir);
        if (isValidScoopRoot(root)) return safeNormalize(root);
      }
      if (isValidScoopRoot(dir)) return safeNormalize(dir);
    }
  } catch (error) {
    logger.debug(`where.exe 探测失败: ${(error as Error).message}`);
  }
  return null;
}

interface Candidate {
  path: string;
  source: ScoopRootSource;
}

function collectRootCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  const push = (path: string | null | undefined, source: ScoopRootSource): void => {
    if (!path) return;
    const normalized = safeNormalize(path);
    if (!candidates.some((candidate) => candidate.path.toLowerCase() === normalized.toLowerCase())) {
      candidates.push({ path: normalized, source });
    }
  };

  const appConfig = getAppConfig();
  push(appConfig.scoopPath, 'app-config');
  push(process.env['SCOOP'], 'env');

  const hints = readScoopConfigHints();
  push(hints.rootPath, 'config-file');
  push(join(homedir(), 'scoop'), 'default');
  push(findByPathLookup(), 'path');

  return candidates;
}

function resolveScriptPath(root: string): string | null {
  const candidates = [join(root, 'apps', 'scoop', 'current', 'bin', 'scoop.ps1'), join(root, 'shims', 'scoop.ps1')];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

function resolveConfigFile(root: string): string {
  const configHome = process.env['SCOOP_CONFIG_HOME'];
  const userDir = join(homedir(), '.config', 'scoop');
  const candidates = [
    configHome ? join(configHome, 'scoop', 'config.json') : null,
    join(userDir, 'config.json'),
    join(root, 'config.json'),
  ].filter((value): value is string => Boolean(value));

  // 已存在的文件优先
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  // 都不存在时按 scoop 自身的规则推断：~/.config/scoop 目录存在则用它，否则落在 scoop 根
  if (isDirectory(userDir)) return join(userDir, 'config.json');
  return join(root, 'config.json');
}

function readScoopVersion(root: string): string | null {
  const scoopApp = join(root, 'apps', 'scoop');

  // 1. 通过 `scoop install scoop` 安装的版本化布局，current 下有 manifest.json
  const manifest = readJson<{ version?: string }>(join(scoopApp, 'current', 'manifest.json'));
  if (manifest && typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version;

  // 2. git 克隆安装（master 通道）没有 manifest.json，版本号只在 CHANGELOG 的首个标题里
  const changelog = readText(join(scoopApp, 'current', 'CHANGELOG.md'));
  if (changelog) {
    const matched = /^#{1,3}\s*\[?v?(\d+\.\d+\.\d+)/m.exec(changelog);
    if (matched?.[1]) return matched[1];
  }

  // 3. 退路：直接看 versions 目录
  const versions = listDirs(join(scoopApp, 'versions'));
  if (versions.length > 0) return versions[versions.length - 1] ?? null;
  return null;
}

/** 判断 scoop 自身的安装通道：git 克隆（master/develop）还是版本化安装。 */
function detectChannel(root: string): 'master' | 'versioned' | null {
  const currentDir = join(root, 'apps', 'scoop', 'current');
  if (!isDirectory(currentDir)) return null;
  return exists(join(currentDir, '.git')) ? 'master' : 'versioned';
}

async function readExecutionPolicy(): Promise<string | null> {
  try {
    const result = await runPowerShellOnce('Get-ExecutionPolicy -Scope CurrentUser', 10000);
    const value = result.stdout.trim().split(/\r?\n/).pop();
    return value && value.length > 0 ? value : null;
  } catch (error) {
    logger.debug(`读取执行策略失败: ${(error as Error).message}`);
    return null;
  }
}

/** 执行一次完整探测。 */
export async function detectScoop(force = false): Promise<ScoopEnvironment> {
  if (!force && cachedEnv && Date.now() - cachedEnv.checkedAt < CACHE_TTL_MS) {
    return cachedEnv;
  }

  const issues: string[] = [];
  const powerShell = findPowerShell();

  if (!isWindows()) {
    issues.push(`当前运行平台为 ${process.platform}，Scoop 仅支持 Windows。`);
  }
  if (!powerShell) {
    issues.push('未找到 PowerShell，无法执行任何 Scoop 命令。');
  }

  let root: string | null = null;
  let rootSource: ScoopRootSource = null;

  for (const candidate of collectRootCandidates()) {
    if (isValidScoopRoot(candidate.path)) {
      root = candidate.path;
      rootSource = candidate.source;
      break;
    }
  }

  if (!root) {
    issues.push('未检测到可用的 Scoop 安装，请使用「一键安装」或「指定已有路径」。');
  }

  const hints = readScoopConfigHints();
  const globalCandidate =
    getAppConfig().scoopGlobalPath ?? process.env['SCOOP_GLOBAL'] ?? hints.globalPath ?? join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'scoop');
  const globalRoot = isValidScoopRoot(globalCandidate) ? safeNormalize(globalCandidate) : null;

  const scriptPath = root ? resolveScriptPath(root) : null;
  if (root && !scriptPath) {
    issues.push(`已定位 Scoop 根目录 ${root}，但未找到 scoop.ps1，请确认安装是否完整。`);
  }

  const env: ScoopEnvironment = {
    platform: process.platform,
    supported: isWindows(),
    installed: Boolean(root && scriptPath),
    root,
    rootSource,
    globalRoot,
    shimsPath: root ? join(root, 'shims') : null,
    appsPath: root ? join(root, 'apps') : null,
    globalAppsPath: globalRoot ? join(globalRoot, 'apps') : null,
    scriptPath,
    version: root ? readScoopVersion(root) : null,
    channel: root ? detectChannel(root) : null,
    configFile: root ? resolveConfigFile(root) : null,
    powershell: {
      path: powerShell?.path ?? null,
      kind: powerShell?.kind ?? null,
      executionPolicy: powerShell ? await readExecutionPolicy() : null,
    },
    issues,
    checkedAt: Date.now(),
  };

  if (env.installed && env.powershell.executionPolicy && /^(Restricted|AllSigned)$/i.test(env.powershell.executionPolicy)) {
    env.issues.push(`当前执行策略为 ${env.powershell.executionPolicy}，本工具会通过 -ExecutionPolicy Bypass 绕过，无需手动修改系统设置。`);
  }

  cachedEnv = env;
  return env;
}

/** 取缓存（可能为 null，调用方自行处理）。 */
export function getCachedScoopEnvironment(): ScoopEnvironment | null {
  return cachedEnv;
}

export function invalidateScoopEnvironment(): void {
  cachedEnv = null;
}

/** 要求已安装，否则抛出可读错误。 */
export async function requireScoopEnvironment(): Promise<ScoopEnvironment & { root: string; scriptPath: string }> {
  const env = await detectScoop();
  if (!env.supported) {
    throw new AppError('PLATFORM_UNSUPPORTED', `Scoop 仅支持 Windows，当前平台为 ${env.platform}。`);
  }
  if (!env.installed || !env.root || !env.scriptPath) {
    throw new AppError('SCOOP_NOT_INSTALLED', '未检测到可用的 Scoop 安装，请先安装或指定已有路径。', {
      detail: { issues: env.issues },
    });
  }
  if (!env.powershell.path) {
    throw new AppError('POWERSHELL_NOT_FOUND', '未找到 PowerShell，无法执行 Scoop 命令。');
  }
  return env as ScoopEnvironment & { root: string; scriptPath: string };
}

/**
 * 指定已有的 scoop 根目录。
 * 会做结构校验后写入应用配置，让后续所有操作都使用这个位置。
 */
export async function setScoopRoot(inputPath: string): Promise<ScoopEnvironment> {
  const normalized = safeNormalize(inputPath.trim().replace(/^"|"$/g, ''));
  if (!isValidScoopRoot(normalized)) {
    throw new AppError(
      'INVALID_PARAM',
      `目录 ${normalized} 看起来不是 Scoop 根目录（未找到 apps 子目录）。请确认路径，例如 %USERPROFILE%\\scoop。`,
    );
  }
  if (!resolveScriptPath(normalized)) {
    throw new AppError('INVALID_PARAM', `目录 ${normalized} 下未找到 scoop.ps1，安装可能不完整。`);
  }

  saveAppConfig({ scoopPath: normalized });
  invalidateScoopEnvironment();
  logger.info(`用户指定 scoop 根目录: ${normalized}`);
  return detectScoop(true);
}

/** 清空用户指定的路径，回到自动探测。 */
export async function clearScoopRoot(): Promise<ScoopEnvironment> {
  saveAppConfig({ scoopPath: null });
  invalidateScoopEnvironment();
  return detectScoop(true);
}

/** 供 installer 使用的 PowerShell 版本信息。 */
export function powerShellInfo(): { path: string | null; kind: PowerShellKind | null } {
  const info = findPowerShell();
  return { path: info?.path ?? null, kind: info?.kind ?? null };
}
