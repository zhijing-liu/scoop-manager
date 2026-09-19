/**
 * 文件系统辅助函数。
 *
 * 统一的容错原则：所有读取类操作在遇到权限不足、文件被占用、JSON 损坏等情况时
 * 都不抛异常，而是返回 null / [] / 默认值。Scoop 的目录里混杂着 junction、
 * 半写入文件与用户手工改坏的 JSON，崩溃比缺失更糟糕。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';

const fsLogger = log.scope('fs');

export function exists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** stat 的安全版本；跟随 junction / 符号链接。 */
export function statSafe(p: string): { mtimeMs: number; size: number; isDir: boolean } | null {
  try {
    const s = statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size, isDir: s.isDirectory() };
  } catch {
    return null;
  }
}

/** 只返回直接子项名称，失败返回空数组。 */
export function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function listFiles(dir: string, extension?: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => (extension ? name.toLowerCase().endsWith(extension.toLowerCase()) : true));
  } catch {
    return [];
  }
}

export function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function readJson<T = Record<string, unknown>>(p: string): T | null {
  const raw = readText(p);
  if (raw === null) return null;
  try {
    return JSON.parse(stripBom(raw)) as T;
  } catch {
    fsLogger.debug(`JSON 解析失败（已忽略）: ${p}`);
    return null;
  }
}

/** Windows 上手工编辑过的 JSON 常带 UTF-8 BOM，JSON.parse 会直接失败。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function ensureDir(dir: string): boolean {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function writeText(p: string, content: string): boolean {
  try {
    writeFileSync(p, content, 'utf8');
    return true;
  } catch (error) {
    fsLogger.warn(`写入失败 ${p}: ${(error as Error).message}`);
    return false;
  }
}

export function writeJson(p: string, data: unknown): boolean {
  try {
    writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    fsLogger.warn(`写入失败 ${p}: ${(error as Error).message}`);
    return false;
  }
}

export interface DirSizeResult {
  bytes: number;
  files: number;
  truncated: boolean;
}

/**
 * 递归统计目录体积。
 * 安全约束：跳过符号链接（Scoop 的 current 就是 junction，跟随会重复计数甚至成环），
 * 限制递归深度与文件数量，避免在异常目录结构上卡死。
 */
export function dirSizeSync(dir: string, options: { maxDepth?: number; maxFiles?: number } = {}): DirSizeResult {
  const maxDepth = options.maxDepth ?? 8;
  const maxFiles = options.maxFiles ?? 20000;
  let bytes = 0;
  let files = 0;
  let truncated = false;

  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth || truncated) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const full = join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          bytes += statSync(full).size;
          files += 1;
          if (files >= maxFiles) {
            truncated = true;
            return;
          }
        }
      } catch {
        // 单个文件不可读不影响整体统计
      }
    }
  };

  walk(dir, 0);
  return { bytes, files, truncated };
}

/** 人类可读的体积格式化。 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/**
 * 生成目录的快照时间戳（用于索引失效判断）。
 * 仅取直接子项的 mtime 与名称，成本 O(n)，不做递归。
 */
export function dirStamp(dir: string): string {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    let latest = 0;
    for (const entry of entries) {
      try {
        const s = statSync(join(dir, entry.name));
        if (s.mtimeMs > latest) latest = s.mtimeMs;
      } catch {
        // ignore
      }
    }
    return `${entries.length}@${latest}`;
  } catch {
    return 'missing';
  }
}
