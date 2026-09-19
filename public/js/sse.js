/**
 * SSE 任务事件流封装。
 *
 * 关键点：
 *   - 用 `?since=<seq>` 做断线补偿，避免重连后丢日志
 *   - 指数退避重连（最长 8 秒），并在 UI 上暴露连接状态
 *   - 收到 done / eof 主动关闭，不做无意义的保活
 */

import { appUrl } from './base.js';

/**
 * @param {string} jobId
 * @param {{ onEvent?: Function, onState?: (state: 'connecting'|'open'|'reconnecting'|'closed') => void, since?: number }} handlers
 * @returns {{ close: () => void, get lastSeq(): number, readonly closed: boolean }}
 */
export function openJobStream(jobId, handlers = {}) {
  const { onEvent, onState, since = 0 } = handlers;
  let lastSeq = since;
  let attempts = 0;
  let closed = false;
  let source = null;
  let timer = null;

  function cleanup() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (source) {
      source.close();
      source = null;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    cleanup();
    onState?.('closed');
  }

  function dispatch(type, event) {
    let payload = null;
    if (event.data) {
      try {
        payload = JSON.parse(event.data);
      } catch {
        payload = null;
      }
    }
    if (payload && typeof payload.seq === 'number' && payload.seq > lastSeq) {
      lastSeq = payload.seq;
    }
    try {
      onEvent?.({ type, payload });
    } catch (error) {
      // 单个事件处理失败不应中断整个流
      console.warn('[sse] 事件处理异常', error);
    }
  }

  function connect() {
    if (closed) return;
    onState?.(attempts === 0 ? 'connecting' : 'reconnecting');

    const url = appUrl(`/api/jobs/${encodeURIComponent(jobId)}/events?since=${lastSeq}`);
    source = new EventSource(url);

    source.onopen = () => {
      attempts = 0;
      onState?.('open');
    };

    const relay = (type) => (event) => {
      dispatch(type, event);
      if (type === 'done') close();
    };

    source.addEventListener('log', relay('log'));
    source.addEventListener('status', relay('status'));
    source.addEventListener('done', relay('done'));
    source.addEventListener('notice', relay('notice'));

    source.addEventListener('eof', () => {
      close();
    });

    source.addEventListener('ping', () => {
      // 心跳，保持连接状态即可
    });

    source.onerror = () => {
      cleanup();
      if (closed) return;
      attempts += 1;
      // 404 等确定性错误不必无限重试，但保持有限次尝试更健壮
      const delay = Math.min(8000, 400 * 2 ** Math.min(attempts, 5));
      onState?.('reconnecting');
      timer = setTimeout(connect, delay);
    };
  }

  connect();

  return {
    close,
    get lastSeq() {
      return lastSeq;
    },
    get closed() {
      return closed;
    },
  };
}
