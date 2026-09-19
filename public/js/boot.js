/**
 * 前端启动钩子（必须是同步、非 defer 的经典脚本，且位于 alpine.min.js 之前）。
 *
 * 背景：本项目把一个「单一 Alpine 组件」注册在 `Alpine.data('app', ...)` 上，
 * 而 Alpine v3 的 CDN 构建在脚本执行末尾会这样做：
 *
 *     window.Alpine = Alpine
 *     queueMicrotask(() => Alpine.start())
 *
 * 也就是说，它会先于后面的模块脚本（main.js）自动 start()，导致 x-data="app"
 * 求值时组件尚未注册（报 "app is not defined"）。
 *
 * Alpine v2 时代可以用 `window.deferLoadingAlpine = true` 推迟启动，但 **v3 已移除**
 * 该开关。因此这里改为在 Alpine 被赋值到 window 的那一刻，把它的 `start` 换成
 * 一个「可挂起」的版本：先记住真正的 start，等 main.js 完成组件注册后调用
 * `window.__releaseAlpine()` 再真正启动。
 *
 * 之所以不改动 vendor 里的压缩产物、也不引入构建步骤，是因为这样对 Alpine 版本
 * 完全无侵入：即使以后替换 vendor 文件，这段时序控制依然成立。
 */
(function () {
  var alpineRef = null;
  var realStart = null;
  var started = false;

  /**
   * 挂起版 start：
   *   - 应用还没准备好 -> 只记录真正的 start，不执行
   *   - 已放行 -> 执行真正的 start
   */
  function deferredStart() {
    if (window.__alpineBootReady) {
      if (started) return undefined;
      started = true;
      return realStart ? realStart() : undefined;
    }
    return undefined;
  }

  Object.defineProperty(window, 'Alpine', {
    configurable: true,
    enumerable: true,
    get: function () {
      return alpineRef;
    },
    set: function (value) {
      alpineRef = value;
      if (!value || typeof value.start !== 'function') return;
      // 绑定 this，避免 deferredStart 被当作普通函数调用时丢失上下文
      realStart = value.start.bind(value);
      value.start = deferredStart;
    },
  });

  /** main.js 注册完组件后调用，放行真正的 start。 */
  window.__releaseAlpine = function () {
    window.__alpineBootReady = true;
    if (!alpineRef) return undefined;
    if (started) return undefined;
    started = true;
    return realStart ? realStart() : undefined;
  };
})();
