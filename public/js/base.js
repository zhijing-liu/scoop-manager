/**
 * 部署前缀（反向代理子路径支持）。
 *
 * 服务端在返回 index.html 时，把当前生效的前缀注入到 `<body data-base="…">`：
 *   - 根路径部署：data-base=""（或 "/"）
 *   - 子路径部署：data-base="/scoop"
 *
 * 前缀来源由服务端决定：优先 `--base-path`，其次请求头 `X-Forwarded-Prefix`，
 * 因此同一份构建产物可以部署在任意子路径，不需要重新打包。
 *
 * 为什么不用 `<base href>`：它会改变文档内**所有**相对 URL 的解析基准，
 * 包括 SVG 精灵里大量的 `href="#i-xxx"` 片段引用，容易让图标失效。
 * 这里只用前缀拼装接口地址，影响面最小。
 */

function readBasePath() {
  const raw = document.body?.dataset?.base ?? '';
  if (!raw || raw === '/' || raw === '.') return '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/** 规范化后的部署前缀，例如 '' 或 '/scoop' */
export const BASE_PATH = readBasePath();

/** 把以 '/' 开头的应用内路径拼成带部署前缀的地址。 */
export function appUrl(path) {
  return `${BASE_PATH}${path}`;
}
