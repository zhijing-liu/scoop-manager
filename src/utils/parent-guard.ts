/**
 * 父进程守护（桌面端专用）。
 *
 * 背景：Tauri 外壳被任务管理器强杀时，OS 不会连带结束子进程，sidecar 会变成
 * 孤儿并长期驻留。这里按固定间隔探测父进程是否存活，父进程消失即自行优雅退出。
 *
 * Windows 下用 process.kill(pid, 0) 做存在性探测：
 *   - 抛 ESRCH  → 进程不存在
 *   - 抛 EPERM  → 进程存在但无权限探测（例如对方提权运行），视为存活
 */

import { createLogger } from './logger.js';

const logger = createLogger('parent-guard');

const CHECK_INTERVAL_MS = 2000;

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

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        stopped = true;
        clearInterval(timer);
        logger.warn(`父进程 ${parentPid} 已退出，子进程跟随关闭。`);
        onExit();
      }
      // EPERM 及其它错误一律视为"仍存活"：宁可多探一轮，也不要误杀正常进程
    }
  }, CHECK_INTERVAL_MS);

  // 不要让这个定时器把进程钉住（否则正常退出会被拖住）
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
