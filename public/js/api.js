/**
 * API 客户端。
 *
 * 统一解包服务端的 { ok, data } / { ok:false, error } 契约：
 *   - 成功直接返回 data，调用方不用再关心外层结构
 *   - 失败抛出 ApiError，带上可读的中文 message 与结构化 code/detail
 */

import { appUrl } from './base.js';

const BASE = appUrl('/api');

export class ApiError extends Error {
  constructor(code, message, detail, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = status ?? 0;
  }
}

async function request(method, path, body) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(BASE + path, init);
  } catch (error) {
    throw new ApiError('NETWORK', '无法连接到本地服务，请确认 scoop-manager 仍在运行。', String(error?.message ?? error), 0);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (payload === null) {
    if (!response.ok) {
      throw new ApiError(`HTTP_${response.status}`, `请求失败（HTTP ${response.status}）`, text.slice(0, 500), response.status);
    }
    return null;
  }

  if (payload.ok === false) {
    const error = payload.error ?? {};
    throw new ApiError(error.code ?? 'UNKNOWN', error.message ?? '请求失败。', error.detail, response.status);
  }

  return payload.data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  del: (path) => request('DELETE', path, {}),
};

/** 把任意异常转成可以展示的中文文案 */
export function errorMessage(error) {
  if (error instanceof ApiError) return error.message;
  if (error?.message) return String(error.message);
  return '发生未知错误。';
}

/** 从异常里提取细节文本（用于「查看详情」） */
export function errorDetail(error) {
  if (!(error instanceof ApiError)) return null;
  if (error.detail === null || error.detail === undefined) return null;
  if (typeof error.detail === 'string') return error.detail;
  try {
    return JSON.stringify(error.detail, null, 2);
  } catch {
    return String(error.detail);
  }
}
