/**
 * Scoop 安装器。
 *
 * 通过官方安装脚本（get.scoop.sh）完成安装，全程把输出接入任务系统，
 * 让前端能看到实时进度。
 *
 * 边界处理：
 *   - PowerShell 5.1 默认使用 TLS 1.0，下载 https 会失败 -> 显式启用 TLS 1.2
 *   - 用户指定的安装目录可能不存在 -> 先创建
 *   - 安装目录可能无写权限 -> 映射为可读中文提示
 *   - 安装完不一定立刻生效 -> 强制重新探测并校验
 *   - Scoop 未安装时 scoop config 不可用 -> 代理只能从外部注入（见下方 proxy）
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { AppError } from '../server/errors.js';
import { exists, isDirectory, ensureDir } from '../utils/fsx.js';
import { createLogger } from '../utils/logger.js';
import { detectScoop, invalidateScoopEnvironment, setScoopRoot, type ScoopEnvironment } from './scoop-locator.js';
import { buildProxyEnv, buildProxyPreamble, isUsableProxy, normalizeProxyUrl } from './proxy-service.js';
import { psQuote } from './powershell.js';
import { run, runOrThrow } from './scoop-runner.js';
import { toAbsolute } from '../utils/paths.js';

const logger = createLogger('installer');

export interface InstallScoopOptions {
  /** 目标安装目录；留空使用 %USERPROFILE%\scoop */
  targetDir?: string | null;
  /** 以管理员身份安装（安装到需要提权的目录时使用） */
  runAsAdmin?: boolean;
  /**
   * 安装过程使用的代理（host:port 或 http://user:pass@host:port）。
   *
   * Scoop 还没装好时 `scoop config proxy` 不存在，而这一步要从 get.scoop.sh
   * 拉脚本、从 GitHub 克隆 bucket，所以只能由调用方注入。
   * 注入是进程级的：环境变量交给 git / aria2，DefaultWebProxy 交给
   * Windows PowerShell 5.1 的 Invoke-RestMethod（它不认环境变量）。
   */
  proxy?: string | null;
  jobId: string;
  onLine?: (stream: 'stdout' | 'stderr' | 'system', line: string) => void;
}

export interface InstallScoopResult {
  targetDir: string;
  environment: ScoopEnvironment;
}

function defaultTargetDir(): string {
  return join(homedir(), 'scoop');
}

export async function installScoop(options: InstallScoopOptions): Promise<InstallScoopResult> {
  if (process.platform !== 'win32') {
    throw new AppError('PLATFORM_UNSUPPORTED', 'Scoop 仅支持 Windows，无法在当前平台安装。');
  }

  const targetDir = options.targetDir && options.targetDir.trim().length > 0 ? toAbsolute(options.targetDir) : defaultTargetDir();

  // 目标目录可能不存在；提前创建可以把"权限不足"暴露在下载之前
  if (!exists(targetDir)) {
    const created = ensureDir(targetDir);
    if (!created) {
      throw new AppError('INVALID_PARAM', `无法创建目录 ${targetDir}，请检查该位置是否有写权限（可能需要以管理员身份运行）。`);
    }
  } else if (!isDirectory(targetDir)) {
    throw new AppError('INVALID_PARAM', `${targetDir} 已存在且不是目录。`);
  }

  const proxyUrl = normalizeProxyUrl(options.proxy);

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    // Windows PowerShell 5.1 默认可能只启用 TLS 1.0，会导致 https 下载失败
    'try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }',
    // PS 5.1 的 Invoke-RestMethod 只认 DefaultWebProxy，不认 HTTP_PROXY 环境变量
    ...(proxyUrl ? [buildProxyPreamble(psQuote(proxyUrl))] : []),
    `$__sm_target = ${psQuote(targetDir)}`,
    "$__sm_url = 'https://get.scoop.sh'",
    options.runAsAdmin
      ? 'Invoke-Expression "& {$(Invoke-RestMethod -Uri $__sm_url -UseBasicParsing)} -ScoopDir `"$__sm_target`" -RunAsAdmin"'
      : 'Invoke-Expression "& {$(Invoke-RestMethod -Uri $__sm_url -UseBasicParsing)} -ScoopDir `"$__sm_target`""',
  ];

  options.onLine?.(
    'system',
    proxyUrl
      ? `已为本次安装启用代理 ${proxyUrl}（仅本次安装进程内生效，不会修改系统代理或 git 配置）。`
      : '未配置代理：将直连 get.scoop.sh 与 GitHub，国内网络可能超时。可先到「配置与代理」或下方填写代理。',
  );
  options.onLine?.('system', `开始安装 Scoop 到 ${targetDir}${options.runAsAdmin ? '（管理员模式）' : ''}…`);

  const result = await run({
    script: lines.join('; '),
    label: '安装 Scoop',
    jobId: options.jobId,
    serial: true,
    timeoutMs: 10 * 60 * 1000,
    // 环境变量交给 git / aria2（克隆 bucket 与后续下载都要走）
    env: buildProxyEnv(options.proxy),
    onLine: (stream, line) => options.onLine?.(stream, line),
  });

  if (result.canceled) {
    throw new AppError('CANCELED', '安装已被取消。');
  }
  if (result.code !== 0) {
    const hint = /Access is denied|拒绝访问/i.test(result.stderr + result.stdout)
      ? '目标目录没有写权限，请更换目录或以管理员身份运行。'
      : proxyUrl
        ? '请检查代理是否可用（安装脚本需要从 get.scoop.sh 与 GitHub 下载），或改用「指定已有路径」手动接入。'
        : '请检查网络连接（安装脚本需要从 get.scoop.sh 与 GitHub 下载）；国内网络建议先设置代理再安装，或改用「指定已有路径」手动接入。';
    throw new AppError('COMMAND_FAILED', `Scoop 安装失败：${hint}`, {
      detail: { exitCode: result.code, output: (result.stderr || result.stdout).slice(-2000) },
    });
  }

  invalidateScoopEnvironment();
  const environment = await detectScoop(true);

  if (!environment.installed) {
    // 安装脚本成功但探测不到：可能装到了别处，或新开的会话才生效。
    throw new AppError(
      'SCOOP_NOT_INSTALLED',
      `安装脚本执行完成，但未能探测到 Scoop 安装（预期目录 ${targetDir}）。请尝试重新打开终端，或在页面上手动指定路径。`,
      { detail: { targetDir, issues: environment.issues } },
    );
  }

  // 安装时用的代理此前只存在于本程序配置里（Scoop 不在时写不进 scoop config）。
  // 既然 Scoop 已经就位，顺手同步过去，后续 scoop 命令（下载、bucket 更新）同样生效。
  // 失败不影响已经完成的安装，只做提示。
  if (isUsableProxy(options.proxy)) {
    try {
      await runOrThrow({
        args: ['config', 'proxy', String(options.proxy)],
        label: 'scoop config proxy',
        timeoutMs: 60_000,
        serial: true,
        jobId: options.jobId,
        onLine: (stream, line) => options.onLine?.(stream, line),
      });
      options.onLine?.('system', '已把该代理同步到 scoop config，后续 scoop 命令同样生效。');
    } catch (error) {
      options.onLine?.('system', `代理同步到 scoop config 失败（不影响已完成的安装）：${(error as Error).message}`);
    }
  }

  logger.info(`Scoop 安装完成，根目录: ${environment.root}`);
  options.onLine?.('system', `Scoop 安装完成，根目录：${environment.root}`);
  return { targetDir, environment };
}

/** 指定已有路径接入（转发到 locator，保持单一职责）。 */
export async function attachExistingScoop(dir: string): Promise<ScoopEnvironment> {
  return setScoopRoot(dir);
}
