/**
 * Hono 应用组装。
 *
 * 挂载顺序很重要：先所有 /api 路由，再静态资源兜底。否则静态兜底会把 API
 * 路径也吃掉（返回 index.html）。
 */

import { Hono, type Context } from 'hono';
import { getAppConfig } from '../config.js';
import { normalizeBasePath } from '../utils/paths.js';
import { createLogger } from '../utils/logger.js';
import { AppError, failure, honoErrorHandler } from './errors.js';
import { looksLikeAsset, readAssetAsync, staticInfo } from './static.js';
import { healthRoutes } from '../routes/health.js';
import { scoopRoutes } from '../routes/scoop.js';
import { bucketRoutes } from '../routes/buckets.js';
import { appRoutes } from '../routes/apps.js';
import { searchRoutes } from '../routes/search.js';
import { configRoutes } from '../routes/config.js';
import { jobRoutes } from '../routes/jobs.js';

const logger = createLogger('http');

/**
 * 内容安全策略。
 *
 * 目标：彻底禁止加载任何外部资源（与"内嵌资源、离线可用"的产品定位一致），
 * 同时满足 Alpine.js 的运行需要：
 *   - script-src 'unsafe-eval'：Alpine 需要把 x-* 表达式编译成函数
 *   - style-src  'unsafe-inline'：x-show / x-bind:style 会写内联样式
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** index.html 中的占位符，响应时替换为实际的反向代理前缀。 */
const BASE_PATH_PLACEHOLDER = '__BASE_PATH__';

const HTML_DECODER = new TextDecoder('utf-8');

/**
 * 计算对外可见的访问前缀。
 *
 * 优先级：应用配置（`--base-path`） > `X-Forwarded-Prefix` 请求头 > 根路径。
 * 后者用于「代理剥离前缀」的部署：nginx 用
 *   proxy_set_header X-Forwarded-Prefix /scoop;
 * 告知对外前缀，此时后端收到的路径里已经没有前缀了。
 */
function resolvePublicPrefix(c: Context): string {
  const configured = getAppConfig().basePath;
  if (configured) return configured;
  return normalizeBasePath(c.req.header('x-forwarded-prefix'));
}

/**
 * 把前缀注入 index.html。
 *
 * 前端据此拼出接口与静态资源的地址（见 public/js/base.js），
 * 因此部署路径无需在构建期确定，换代理前缀也不必重新打包 exe。
 * 前缀已被 normalizeBasePath 限制为 [A-Za-z0-9._~-] 与 '/'，可安全放入属性。
 */
function injectBasePath(html: string, prefix: string): string {
  if (!html.includes(BASE_PATH_PLACEHOLDER)) return html;
  // 占位符同时出现在静态资源地址与 <body data-base>，需全量替换
  return html.replaceAll(BASE_PATH_PLACEHOLDER, prefix);
}

export function createApp(): Hono {
  const app = new Hono();

  // ---- 访问日志：跳过长连接的 SSE，避免刷屏
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const isStream = /\/api\/jobs\/[^/]+\/events$/.test(path);
    if (isStream) return next();

    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    logger.debug(`${c.req.method} ${path} -> ${c.res.status} (${duration}ms)`);
  });

  // ---- API 一律禁止缓存
  // /api/apps、/api/overview 等是固定 URL 的数据接口，若不带缓存策略，
  // 浏览器（服务模式）会启用启发式缓存，直接用本地旧 JSON 应答、根本不发请求，
  // 表现为「点刷新 / 重新扫描永远是旧数据」。桌面 IPC 模式虽走 stdio 不经缓存，
  // 带头也无害。SSE 长连接同样不应被缓存。
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  // ---- API
  app.route('/api', healthRoutes);
  app.route('/api', scoopRoutes);
  app.route('/api', bucketRoutes);
  app.route('/api', appRoutes);
  app.route('/api', searchRoutes);
  app.route('/api', configRoutes);
  app.route('/api', jobRoutes);

  // 未匹配到的 API 路径统一返回 JSON 错误，而不是落到静态兜底
  app.all('/api/*', (c) => {
    const body = failure(new AppError('NOT_FOUND', `接口不存在：${c.req.method} ${c.req.path}`, { status: 404 }));
    return c.json(body, 404);
  });

  // ---- 静态资源
  app.get('*', async (c) => {
    const url = new URL(c.req.url);
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');

    let assetPath = requested;
    let asset = await readAssetAsync(requested);
    // 无扩展名的路径视为前端入口（当前为单页 + x-show 切换，无客户端路由，但保持兼容）
    if (!asset && !looksLikeAsset(requested)) {
      assetPath = 'index.html';
      asset = await readAssetAsync('index.html');
    }

    if (!asset) {
      const info = staticInfo();
      const body = failure(
        new AppError('NOT_FOUND', '静态资源不存在。', {
          status: 404,
          detail: { requested, resolvedDir: info.dir, source: info.source },
        }),
      );
      return c.json(body, 404);
    }

    const headers: Record<string, string> = {
      'Content-Type': asset.contentType,
      'Cache-Control': asset.cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer',
    };

    // index.html 需要按请求注入对外前缀（同一份产物可服务任意子路径部署）
    if (assetPath === 'index.html') {
      return new Response(injectBasePath(HTML_DECODER.decode(asset.body), resolvePublicPrefix(c)), { headers });
    }

    // AssetResult.body 是 Buffer（Uint8Array 子类）。Node 的 undici 与 Bun 的
    // Response 都接受 Uint8Array，但 @types/node 未在全局暴露 BodyInit 名称，
    // 因此这里做一次收敛到 ArrayBuffer 的类型断言（运行时行为不受影响）。
    return new Response(asset.body as unknown as ArrayBuffer, { headers });
  });

  app.notFound((c) => {
    const body = failure(new AppError('NOT_FOUND', `路径不存在：${c.req.path}`, { status: 404 }));
    return c.json(body, 404);
  });

  app.onError(honoErrorHandler);

  return app;
}
