/**
 * 任务与实时日志接口。
 *
 * SSE 设计要点：
 *   - 事件 id = 单调递增的 seq，前端断线后带上 `?since=<seq>` 重连即可补齐；
 *   - 事件类型区分 log / status / done，前端分别处理；
 *   - 15 秒心跳注释，避免中间代理或浏览器回收空闲连接；
 *   - 任务已结束时只重放历史，不保持长连接。
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AppError, envelope } from '../server/errors.js';
import { jobManager } from '../jobs/manager.js';
import { mutationQueue } from '../scoop-core/queue.js';
import { toInteger } from '../utils/validate.js';
import type { JobEvent, JobKind, JobStatus } from '../jobs/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('sse');

export const jobRoutes = new Hono();

const HEARTBEAT_MS = 15000;

jobRoutes.get('/jobs', (c) => {
  const status = c.req.query('status') as JobStatus | undefined;
  const kind = c.req.query('kind') as JobKind | undefined;
  const limit = toInteger(c.req.query('limit'), 100, 1, 500);
  return c.json(
    envelope({
      items: jobManager.list({ status, kind, limit }),
      running: jobManager.runningCount(),
      queued: mutationQueue.queued,
    }),
  );
});

jobRoutes.post('/jobs/clear', (c) => {
  const removed = jobManager.clearFinished();
  return c.json(envelope({ removed }));
});

jobRoutes.get('/jobs/:id', (c) => {
  const id = c.req.param('id');
  return c.json(envelope(jobManager.detail(id)));
});

jobRoutes.post('/jobs/:id/cancel', (c) => {
  const id = c.req.param('id');
  const result = jobManager.cancel(id);
  return c.json(envelope(result));
});

jobRoutes.delete('/jobs/:id', (c) => {
  const id = c.req.param('id');
  jobManager.remove(id);
  return c.json(envelope({ removed: true }));
});

jobRoutes.get('/jobs/:id/events', (c) => {
  const id = c.req.param('id');
  const sinceRaw = c.req.query('since') ?? c.req.header('Last-Event-ID') ?? '0';
  const since = toInteger(sinceRaw, 0, 0, Number.MAX_SAFE_INTEGER);

  // 先做一次存在性校验，任务不存在直接返回 404 而不是空流
  if (!jobManager.get(id)) {
    throw new AppError('JOB_NOT_FOUND', '任务不存在或已被清理。', { status: 404 });
  }

  return streamSSE(c, async (stream) => {
    const pending: JobEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;

    const notify = (): void => {
      if (wake) {
        const resume = wake;
        wake = null;
        resume();
      }
    };

    const writeEvent = async (event: JobEvent | { type: 'ping' }): Promise<void> => {
      if ('seq' in event) {
        await stream.writeSSE({
          event: event.type,
          id: String(event.seq),
          data: JSON.stringify(event),
        });
      } else {
        await stream.writeSSE({ event: 'ping', data: '{}' });
      }
    };

    // 1. 重放历史
    const replay = jobManager.eventsSince(id, since);
    for (const event of replay.events) {
      await writeEvent(event);
    }
    if (replay.truncated) {
      await stream.writeSSE({ event: 'notice', data: JSON.stringify({ code: 'TRUNCATED', message: '更早的日志已超出缓冲上限被丢弃。' }) });
    }

    // 2. 任务已结束则直接收尾
    if (jobManager.isTerminal(id)) {
      await stream.writeSSE({ event: 'eof', data: '{}' });
      return;
    }

    // 3. 订阅增量
    const unsubscribe = jobManager.subscribe(id, (event) => {
      pending.push(event);
      notify();
    });

    stream.onAbort(() => {
      closed = true;
      unsubscribe();
      notify();
    });

    try {
      while (!closed) {
        if (pending.length === 0) {
          await Promise.race([
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
            stream.sleep(HEARTBEAT_MS),
          ]);
          // race 结束后 wake 可能仍指向已 settle 的 resolver（心跳先醒时），
          // 立刻清空：后续 notify 不会再调到这个 no-op，状态也更明确。
          wake = null;
          if (closed) break;
          if (pending.length === 0) {
            if (jobManager.isTerminal(id)) break;
            await writeEvent({ type: 'ping' });
            continue;
          }
        }

        const batch = pending.splice(0, pending.length);
        for (const event of batch) {
          if (closed) break;
          await writeEvent(event);
        }

        if (jobManager.isTerminal(id) && pending.length === 0) break;
      }
    } catch (error) {
      logger.debug(`SSE 流结束: ${(error as Error).message}`);
    } finally {
      unsubscribe();
      if (!closed) {
        try {
          await stream.writeSSE({ event: 'eof', data: '{}' });
        } catch {
          // 客户端已断开，忽略
        }
      }
    }
  });
});
