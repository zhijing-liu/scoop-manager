/**
 * PowerShell 适配层。
 *
 * Scoop 本身是一组 PowerShell 脚本，因此"调用 scoop"本质上就是"调用 PowerShell"。
 * 这一层负责三件事，都是踩过坑才总结出来的：
 *
 * 1. **绝对路径探测**：优先 PowerShell 7（pwsh.exe），回退 Windows PowerShell 5.1。
 * 2. **输出编码**：Windows PowerShell 5.1 在输出被重定向时默认使用 OEM 代码页，
 *    中文日志必然乱码。必须在命令最前面设置 [Console]::OutputEncoding。
 * 3. **参数转义**：绝不使用 shell:true。所有参数以 PowerShell 单引号字面量拼接，
 *    内部的单引号用 '' 转义；配合 utils/validate 的白名单校验形成双重防线。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('powershell');

export type PowerShellKind = 'pwsh' | 'windows-powershell';

export interface PowerShellInfo {
  path: string;
  kind: PowerShellKind;
}

let cached: PowerShellInfo | null | undefined;

/**
 * 探测可用的 PowerShell。
 *
 * 顺序：PowerShell 7 常见安装位置 -> Microsoft Store 别名 -> 系统自带 5.1。
 * 系统自带的 powershell.exe 一定存在，因此正常情况下不会返回 null。
 */
export function findPowerShell(): PowerShellInfo | null {
  if (cached !== undefined) return cached;

  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';

  const pwshCandidates = [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(programFiles, 'PowerShell', '6', 'pwsh.exe'),
    join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
    localAppData ? join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe') : '',
  ].filter((candidate) => candidate.length > 0);

  for (const candidate of pwshCandidates) {
    if (safeExists(candidate)) {
      cached = { path: candidate, kind: 'pwsh' };
      logger.info(`使用 PowerShell 7: ${candidate}`);
      return cached;
    }
  }

  const legacy = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (safeExists(legacy)) {
    cached = { path: legacy, kind: 'windows-powershell' };
    logger.info(`使用 Windows PowerShell: ${legacy}`);
    return cached;
  }

  cached = null;
  logger.error('未能在常见路径下找到 PowerShell，Scoop 相关功能将不可用。');
  return null;
}

export function requirePowerShell(): PowerShellInfo {
  const info = findPowerShell();
  if (!info) {
    throw new AppError('POWERSHELL_NOT_FOUND', '未找到 PowerShell（pwsh.exe / powershell.exe），无法执行 Scoop 命令。');
  }
  return info;
}

export function invalidatePowerShellCache(): void {
  cached = undefined;
}

function safeExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** 转义为 PowerShell 单引号字面量。 */
export function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 统一前置。所有命令都会带上它：
 *   - ErrorActionPreference=Continue：让 scoop 自己的 try/catch 有机会接管错误
 *   - ProgressPreference=SilentlyContinue：去掉下载进度条产生的大量控制字符
 *   - 输出编码统一为 UTF-8，解决中文乱码
 */
const PRELUDE = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
  'try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
].join('; ');

/** 构造"调用某个 .ps1 脚本"的完整命令。 */
export function buildScriptCommand(scriptPath: string, args: string[]): string {
  const quotedArgs = args.map((arg) => psQuote(arg)).join(' ');
  const invocation = quotedArgs.length > 0 ? `& ${psQuote(scriptPath)} ${quotedArgs}` : `& ${psQuote(scriptPath)}`;
  // `| Out-Default` 必须出现在 `exit` 之前，顺序不能换：
  //   -Command 模式下 PowerShell 会把「管道输出对象」缓存到命令结束才渲染，
  //   而 `exit` 会立刻终止运行空间，把这些尚未渲染的对象整批丢掉。
  // `scoop status` 的表格正是这样消失的（只剩 Write-Host 直接写出的 WARN 行），
  // 于是「检查更新状态」永远解析到 0 项、界面显示"全部最新"——典型的假阴性。
  // Out-Default 在管道内立即渲染；$LASTEXITCODE 不受影响（exit 仍把 scoop 的退出码透传）。
  return `${PRELUDE}; ${invocation} | Out-Default; exit $LASTEXITCODE`;
}

/**
 * 构造自定义 PowerShell 脚本。
 * 调用方负责确保 body 中已经对动态值调用过 psQuote —— 不要把未转义的用户输入拼进来。
 */
export function buildRawCommand(body: string): string {
  return `${PRELUDE}; ${body}`;
}

/** PowerShell 通用参数。 */
export function powerShellArgs(command: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
}

export interface PowerShellSyncResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 同步式（一次性收集输出）执行 PowerShell 脚本，带超时保护。
 * 适用于探测类命令：查版本、查执行策略、列 known bucket。
 */
export function runPowerShellOnce(command: string, timeoutMs = 20000, env?: Record<string, string>): Promise<PowerShellSyncResult> {
  const info = requirePowerShell();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const child = spawn(info.path, powerShellArgs(command), {
      windowsHide: true,
      env: { ...process.env, ...(env ?? {}) },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    child.stdin?.end();
  });
}

/**
 * 结束整个进程树。
 *
 * 必须用 /T：scoop 会派生 aria2c、7z、git 等子进程，只杀父进程会留下孤儿进程
 * 继续占用文件句柄，导致后续 install 报"文件被占用"。
 * 使用 taskkill 而非 shell 内建命令，因此依然不经过 shell。
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', (error) => {
      logger.warn(`taskkill 调用失败: ${error.message}`);
    });
    killer.unref();
  } catch (error) {
    logger.warn(`结束进程树失败: ${(error as Error).message}`);
  }
}
