/**
 * 桌面端 IPC 垫片。
 *
 * 由 Tauri 的 initialization_script 注入，执行时机早于页面里任何脚本，
 * 因此在 public/js/api.js 取 window.fetch、public/js/sse.js 取 window.EventSource
 * 之前就已经替换完成 —— 这正是 public/ 目录能够零改动的原因。
 *
 * 拦截范围刻意收得很窄：
 *   - 只接管同源的 /api/** 请求；静态资源、外链一律交回原生实现
 *   - 只接管字符串 body（前端当前只发 JSON 字符串）
 *   - 任何异常都回退到原生 fetch，不让垫片成为单点故障
 *
 * 帧格式与 src/server/adapter.ipc.ts、desktop/src/bridge.rs 三方一致：
 *   u32 BE headerLength | JSON header (UTF-8) | body
 *
 * 目标环境是 WebView2（Chromium），可以放心使用 class / const / 可选链。
 */
(() => {
  'use strict';

  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.core.invoke || !tauri.event || !tauri.event.listen) {
    // 非桌面环境（例如服务模式下的浏览器）：保持原生行为
    return;
  }

  const invoke = tauri.core.invoke;
  const listen = tauri.event.listen;
  const nativeFetch = window.fetch.bind(window);
  const NativeEventSource = window.EventSource;
  const decoder = new TextDecoder('utf-8');

  /** 只接管这个前缀，其余一律放行 */
  const API_ROOT = '/api';

  // ---------------------------------------------------------------- 工具

  /** 同源的 /api/** 路径返回带 query 的路径；其余返回 null 表示"不接管" */
  function toApiPath(input) {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
    if (!raw) return null;
    try {
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin) return null;
      if (url.pathname !== API_ROOT && !url.pathname.startsWith(`${API_ROOT}/`)) return null;
      return url.pathname + url.search;
    } catch {
      return null;
    }
  }

  function readHeaders(source) {
    const headers = {};
    if (!source) return headers;
    if (typeof source.forEach === 'function') {
      source.forEach((value, key) => {
        headers[String(key).toLowerCase()] = String(value);
      });
    } else if (Array.isArray(source)) {
      for (const pair of source) headers[String(pair[0]).toLowerCase()] = String(pair[1]);
    } else {
      for (const key of Object.keys(source)) headers[key.toLowerCase()] = String(source[key]);
    }
    return headers;
  }

  /** 解开「u32 BE 头长 | JSON 头 | 原始 body」 */
  function unpack(buffer) {
    const view = new DataView(buffer);
    const headerLength = view.getUint32(0, false);
    const header = JSON.parse(decoder.decode(new Uint8Array(buffer, 4, headerLength)));
    const body = new Uint8Array(buffer, 4 + headerLength);
    return { header, body };
  }

  // ---------------------------------------------------------------- fetch

  window.fetch = async (input, init) => {
    const path = toApiPath(input);
    if (!path) return nativeFetch(input, init);

    const request = input instanceof Request ? input : null;
    const method = String((init && init.method) || (request && request.method) || 'GET').toUpperCase();
    const body = init ? init.body : null;

    // 非字符串 body（FormData / Blob / ArrayBuffer）交回原生实现，避免误伤
    if (body !== null && body !== undefined && typeof body !== 'string') {
      return nativeFetch(input, init);
    }

    const buffer = await invoke('api_request', {
      method,
      path,
      headers: readHeaders((init && init.headers) || (request && request.headers)),
      body: body === undefined ? null : body,
    });

    const frame = unpack(buffer);
    // 还原成标准 Response：api.js 的 .text() / .ok / .status 全部照旧可用
    return new Response(frame.body, {
      status: frame.header.status,
      headers: frame.header.headers || {},
    });
  };

  // ---------------------------------------------------------------- EventSource

  /**
   * 极简 SSE 解析：按空行切块，取 event / data 字段，忽略注释（心跳）。
   * 分块边界与 SSE 事件边界无关，所以必须自己缓冲。
   */
  function createSseParser(onEvent) {
    let buffer = '';

    function dispatchBlock(block) {
      let type = 'message';
      const data = [];

      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;

        const colon = line.indexOf(':');
        const field = colon >= 0 ? line.slice(0, colon) : line;
        let value = colon >= 0 ? line.slice(colon + 1) : '';
        if (value.startsWith(' ')) value = value.slice(1);

        if (field === 'event') type = value;
        else if (field === 'data') data.push(value);
      }

      if (data.length === 0 && type === 'message') return;
      onEvent(type, data.join('\n'));
    }

    return (text) => {
      buffer += text;
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        dispatchBlock(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
    };
  }

  /**
   * EventSource 的 IPC 实现。
   *
   * 必须用 class 继承 EventTarget：EventTarget 是原生构造函数，只支持
   * `new` / `super()`，写成 ES5 风格的 `EventTarget.call(this)` 会直接抛
   * "Please use the 'new' operator, this DOM object constructor cannot be
   * called as a function"。
   */
  class IpcEventSource extends EventTarget {
    constructor(url) {
      super();

      this.url = String(url);
      this.readyState = IpcEventSource.CONNECTING;
      this.withCredentials = false;
      this.onopen = null;
      this.onerror = null;
      this.onmessage = null;

      // 内部状态，用下划线前缀与 EventSource 的公开字段区分开
      this._streamId = `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      this._releasers = [];
      this._closed = false;
      this._native = null;

      const path = toApiPath(this.url);
      if (path) {
        void this._connect(path);
      } else {
        this._useNativeFallback();
      }
    }

    async _connect(path) {
      try {
        // 先注册监听再发起请求：Rust 侧只有收到 api_stream_start 才会开始推
        // 分块，因此不存在"分块早于监听"的竞态。
        const releasers = await Promise.all([
          listen(`rpc:chunk:${this._streamId}`, (event) => this._feed(String((event && event.payload) || ''))),
          listen(`rpc:end:${this._streamId}`, () => this._finish()),
          listen(`rpc:error:${this._streamId}`, () => this._fail()),
        ]);

        if (this._closed) {
          // 在注册过程中用户已经 close()：立刻释放，避免泄漏监听
          for (const release of releasers) release();
          return;
        }
        this._releasers.push(...releasers);

        await invoke('api_stream_start', { streamId: this._streamId, path });
        if (this._closed) return;

        this.readyState = IpcEventSource.OPEN;
        if (typeof this.onopen === 'function') this.onopen(new Event('open'));
      } catch (error) {
        console.warn('[scoop-manager] 日志流建立失败', error);
        this._fail();
      }
    }

    /** 理论上不会走到：前端只会订阅 /api/**。保底回退到原生实现。 */
    _useNativeFallback() {
      if (typeof NativeEventSource !== 'function') {
        this._fail();
        return;
      }
      const native = new NativeEventSource(this.url);
      this._native = native;

      for (const type of ['log', 'status', 'done', 'notice', 'eof', 'ping']) {
        native.addEventListener(type, (event) => this._emit(type, event.data));
      }
      native.onopen = () => {
        this.readyState = IpcEventSource.OPEN;
        if (typeof this.onopen === 'function') this.onopen(new Event('open'));
      };
      native.onerror = () => this._fail();
    }

    _emit(type, payload) {
      if (this._closed) return;
      const event = new MessageEvent(type, { data: payload, origin: location.origin });
      if (type === 'message' && typeof this.onmessage === 'function') this.onmessage(event);
      this.dispatchEvent(event);
    }

    _feed(text) {
      if (this._closed) return;
      this._parser = this._parser || createSseParser((type, payload) => this._emit(type, payload));
      this._parser(text);
    }

    _release() {
      const releasers = this._releasers.splice(0);
      for (const release of releasers) {
        try {
          release();
        } catch {
          /* 忽略 */
        }
      }
      if (this._native) {
        try {
          this._native.close();
        } catch {
          /* 忽略 */
        }
        this._native = null;
      }
    }

    _finish() {
      if (this._closed) return;
      this._closed = true;
      this.readyState = IpcEventSource.CLOSED;
      this._release();
    }

    _fail() {
      this._release();
      this._closed = true;
      this.readyState = IpcEventSource.CLOSED;
      if (typeof this.onerror === 'function') this.onerror(new Event('error'));
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      this.readyState = IpcEventSource.CLOSED;
      this._release();
      // 通知 Rust 丢弃这条流的挂起状态，避免泄漏
      void invoke('api_stream_cancel', { streamId: this._streamId }).catch(() => {});
    }
  }

  IpcEventSource.CONNECTING = 0;
  IpcEventSource.OPEN = 1;
  IpcEventSource.CLOSED = 2;

  window.EventSource = IpcEventSource;

  console.info('[scoop-manager] 桌面 IPC 垫片已启用：/api 走 stdio 通道，全程不占用端口。');
})();
