/**
 * 生成桌面端静态资源目录 `desktop/ui/`。
 *
 * 为什么要复制一份而不是直接指向 public/
 * ──────────────────────────────────────
 * `public/index.html` 里的资源地址带 `__BASE_PATH__` 占位符，由服务模式下的
 * Hono 在响应时按部署前缀替换（见 src/server/app.ts 的 injectBasePath）。
 * Tauri 直接读磁盘文件，没有这一层替换，占位符会原样保留导致资源 404。
 * 桌面端固定部署在根路径，因此占位符一律替换为空串。
 *
 * 为什么必须做增量而不是 rm -rf + 全量拷贝
 * ────────────────────────────────────────
 * `tauri::generate_context!()` 会跟踪 desktop/ui/ 下**每个文件**的变化。
 * 全量重建会刷新所有 mtime，于是 cargo 每次都判定 crate 失效，白白重编译
 * 并重新做一次 LTO 链接 —— 表现为"一行代码没改，构建也要好几分钟"。
 * 因此这里逐文件比对内容，只在真正不同时才写盘。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SOURCE = join(ROOT, 'public');
const OUT = join(ROOT, 'desktop', 'ui');

/** 占位符只出现在 index.html；其余文件原样搬运 */
const PLACEHOLDER_FILE = 'index.html';
const PLACEHOLDER = '__BASE_PATH__';

/** 递归列出目录下所有文件的相对路径 */
function listFiles(root: string, base = ''): string[] {
  const dir = base ? join(root, base) : root;
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = base ? join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/** 读取源文件并应用占位符替换，得到该文件应有的最终内容 */
function desiredContent(relative: string): Buffer {
  const raw = readFileSync(join(SOURCE, relative));
  if (relative !== PLACEHOLDER_FILE) return raw;
  return Buffer.from(raw.toString('utf8').replaceAll(PLACEHOLDER, ''), 'utf8');
}

function writeIfChanged(target: string, content: Buffer): boolean {
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (existing.length === content.length && existing.equals(content)) return false;
  }
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
  return true;
}

function main(): void {
  const wanted = new Map<string, Buffer>();
  for (const relative of listFiles(SOURCE)) {
    wanted.set(relative, desiredContent(relative));
  }

  // 统计的是「源文件里占位符出现次数」。不能用 wanted.get(...).length ——
  // 那是替换之后的 Buffer 字节数，只要文件非空就永远大于 0，告警永远不会触发。
  const sourceIndex = join(SOURCE, PLACEHOLDER_FILE);
  const occurrences = existsSync(sourceIndex)
    ? readFileSync(sourceIndex, 'utf8').split(PLACEHOLDER).length - 1
    : 0;
  if (occurrences === 0) {
    console.warn('警告：public/index.html 中未找到 __BASE_PATH__ 占位符，请确认该文件未被改动。');
  }

  let written = 0;
  for (const [relative, content] of wanted) {
    if (writeIfChanged(join(OUT, relative), content)) written += 1;
  }

  // 清理源目录里已经不存在的文件，避免残留旧资源被打进包
  let removed = 0;
  for (const relative of existsSync(OUT) ? listFiles(OUT) : []) {
    if (wanted.has(relative)) continue;
    rmSync(join(OUT, relative), { force: true });
    removed += 1;
  }

  console.log('桌面端静态资源已同步');
  console.log(`  源目录  ${SOURCE}`);
  console.log(`  输出    ${OUT}`);
  console.log(`  共 ${wanted.size} 个文件，本次写入 ${written} 个，清理 ${removed} 个`);
  if (written === 0 && removed === 0) {
    console.log('  内容无变化，未触碰任何文件（保持 mtime，cargo 可跳过重编译）');
  }
}

main();
