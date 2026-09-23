/**
 * 串行任务队列。
 *
 * 存在的原因：Scoop 自身不保证并发安全 —— 同时执行 install / update 会争抢
 * 同一个 download cache 与 bucket 目录，产生难以复现的损坏。因此所有"会改变
 * 磁盘状态"的操作都必须在这条单通道上排队执行；只读操作（扫描、读取 manifest）
 * 不受此限制。
 */

import { createLogger } from './logger.js';

const logger = createLogger('queue');

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  /** 队列里的任务总数（含正在执行的那一个） */
  get pending(): number {
    return this.waiting;
  }

  /** 真正在排队等待的数量（不含正在执行的那一个），用于对外上报 queued */
  get queued(): number {
    return Math.max(0, this.waiting - 1);
  }

  run<T>(label: string, task: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    if (this.waiting > 1) {
      logger.info(`「${label}」进入队列等待（前方还有 ${this.waiting - 1} 个任务）`);
    }

    const execute = this.tail.then(
      () => task(),
      () => task(),
    );

    const settled = execute.finally(() => {
      this.waiting -= 1;
    });

    // 队列尾部吞掉异常，避免一次失败污染后续任务的链
    this.tail = settled.catch(() => undefined);
    return settled;
  }
}

export const mutationQueue = new SerialQueue();
