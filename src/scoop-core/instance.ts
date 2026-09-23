/**
 * 已经注入好 jobs 集成的 ScoopClient 单例。
 *
 * 路由层和任务层用它就够了；它自动把 jobManager 的取消能力接回 runner，
 * 路由层只需要：const job = startJob({ execute: async (ctx) => { ... } })
 * 而 ctx 会自动接 cancel / queue / 日志。
 *
 * （独立部署 scoop-core 时，本文件整个可以丢掉；hookRun 由宿主自行注入。）
 */

import { ScoopClient } from './client.js';
import type { RunOptions } from './runner.js';
import { jobManager } from '../jobs/manager.js';

// 把 ScoopClient 也再导出，便于路由层 import（既可以是值也可以是类型）
export { ScoopClient };

export const scoopClient = new ScoopClient({
  labelPrefix: 'scoop-manager',
  hookRun: (defaults: RunOptions): RunOptions => {
    return {
      ...defaults,
      // 只在调用方没提供时兜底。硬写死会把外部注入的取消能力直接抹掉，
      // 接入方明明传了 cancelRequested 也永远收不到取消。
      cancelRequested: defaults.cancelRequested ?? (() => false),
      setCancelHandler: defaults.setCancelHandler ?? (() => {}),
    };
  },
});

/** 在 startJob 内部使用的 hook —— 绑定到具体 jobId。 */
export function createJobHook(jobId: string): (defaults: RunOptions) => RunOptions {
  return (defaults: RunOptions): RunOptions => ({
    ...defaults,
    cancelRequested: () => jobManager.isCancelRequested(jobId),
    setCancelHandler: (handler: (() => void) | null) => jobManager.setCancelHandler(jobId, handler),
  });
}
