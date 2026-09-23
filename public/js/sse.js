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
  /**
   * 重连次数上限。指数退避到 8s 后，超过这个次数仍然连不上就放弃，
   * 避免任务已被清理（404）时无限重连、把控制台和网络面板刷满。
   */
  const MAX_ATTEMPTS = 15;
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
      // readyState=CLOSED 表示浏览器已判定这条连接不可恢复（例如 404、
      // 响应不是 text/event-stream），这类情况重试没有意义。
      const fatal = !source || source.readyState === 2;
      cleanup();
      if (closed) return;
      attempts += 1;
      if (fatal || attempts > MAX_ATTEMPTS) {
        close();
        return;
      }
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
