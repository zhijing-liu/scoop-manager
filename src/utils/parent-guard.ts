/**
 * 父进程守护（桌面端专用）。
 *
 * 背景：Tauri 外壳被任务管理器强杀时，OS 不会连带结束子进程，sidecar 会变成
 * 孤儿并长期驻留。这里按固定间隔探测父进程是否存活，父进程消失即自行优雅退出。
 *
 * 存活判定有两层：
 *   1. 廉价探测（每 2 秒）：process.kill(pid, 0)
 *        - 抛 ESRCH  → 进程不存在
 *        - 抛 EPERM  → 进程存在但无权限探测（例如对方提权运行），视为存活
 *   2. 身份复核（Windows，每 30 秒）：比对父进程的启动时间（StartTime）
 *      廉价探测只能确认"该 PID 上有进程"，父进程退出后 PID 可能在两次轮询之间
 *      被 OS 回收并分配给无关进程，此时只看 PID 会误判存活。启动时间是进程的
 *      稳定身份标识，不一致即说明原父进程已被替换。
 *
 * 复核失败（PowerShell 不可用、查询超时等）一律 fail-open：保持原有廉价探测
 * 行为，不因监控手段本身故障而误杀正常服务。
 */

import { findPowerShell, runPowerShellOnce } from '../scoop-core/powershell.js';
import { createLogger } from './logger.js';

const logger = createLogger('parent-guard');

const CHECK_INTERVAL_MS = 2000;
/** 每 N 次廉价探测做一次启动时间复核（15 × 2s = 30s） */
const VERIFY_EVERY_TICKS = 15;

/**
 * 读取目标进程的启动时间（Windows FILETIME ticks 字符串）。
 * 进程不存在或查询失败时返回 null，由调用方决定 fail-open 策略。
 */
async function readProcessBirth(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  if (!findPowerShell()) return null;
  try {
    // -ErrorAction SilentlyContinue：进程已消失时 Get-Process 会抛错，stdout 为空
    const result = await runPowerShellOnce(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToFileTime() }`,
      8000,
    );
    const value = result.stdout.trim();
    return /^\d+$/.test(value) ? value : null;
  } catch (error) {
    logger.debug(`父进程启动时间查询失败: ${(error as Error).message}`);
    return null;
  }
}

/**
 * 监视父进程存活状态。
 *
 * @param parentPid 父进程 PID
 * @param onExit    父进程消失时调用（通常是优雅退出流程）
 * @returns 停止监视的函数
 */
export function watchParent(parentPid: number, onExit: () => void): () => void {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return () => {};

  let stopped = false;
  let expectedBirth: string | null = null;
  let verifying = false;
  let tick = 0;

  const triggerExit = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    logger.warn(reason);
    onExit();
  };

  const timer = setInterval(() => {
    if (stopped || verifying) return;

    // 1. 廉价存在性探测
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        triggerExit(`父进程 ${parentPid} 已退出，子进程跟随关闭。`);
        return;
      }
      // EPERM 及其它错误一律视为"仍存活"：宁可多探一轮，也不要误杀正常进程
    }

    // 2. 周期性身份复核（仅 Windows，拿到基准启动时间之后生效）
    tick += 1;
    if (process.platform !== 'win32' || tick % VERIFY_EVERY_TICKS !== 0) return;

    verifying = true;
    void readProcessBirth(parentPid)
      .then((current) => {
        verifying = false;
        if (stopped) return;
        if (current === null) return; // 查询失败，fail-open
        if (expectedBirth === null) {
          expectedBirth = current; // 首次成功查询，建立基准
          return;
        }
        if (current !== expectedBirth) {
          triggerExit(`父进程 PID ${parentPid} 已被其他进程复用（启动时间 ${expectedBirth} → ${current}），子进程跟随关闭。`);
        }
      })
      .catch(() => {
        verifying = false;
      });
  }, CHECK_INTERVAL_MS);

  // 启动时异步建立基准（不阻塞监视启动；建立前的空窗期由廉价探测兜底）
  void readProcessBirth(parentPid).then((birth) => {
    if (!stopped && birth !== null) expectedBirth = birth;
  });

  // 不要让这个定时器把进程钉住（否则正常退出会被拖住）
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
