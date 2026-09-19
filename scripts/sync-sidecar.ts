/**
 * 把 `bun run build:exe` 的产物同步为 Tauri externalBin 要求的命名。
 *
 * Tauri 规定 sidecar 文件名必须带目标三元组后缀，形如
 *   desktop/binaries/scoop-manager-x86_64-pc-windows-msvc.exe
 * 否则打包时找不到、或在目标平台上静默缺失。
 *
 * 三元组通过 `rustc -vV` 的 host 行探测，避免硬编码导致换平台就失败。
 */

import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SOURCE = join(ROOT, 'dist', 'scoop-manager.exe');
const DEST_DIR = join(ROOT, 'desktop', 'binaries');

const FALLBACK_TRIPLE = 'x86_64-pc-windows-msvc';

const CHUNK_SIZE = 1024 * 1024;

/**
 * 分块比对两个文件是否完全一致。
 *
 * sidecar 有 80+ MB，不能整份读进内存；同时也不能只看大小或 mtime 就下结论。
 * 比对通过时跳过复制，既省掉一次大文件 I/O，也让目标文件 mtime 保持不变。
 */
function isSameFile(first: string, second: string): boolean {
  const size = statSync(first).size;
  if (size !== statSync(second).size) return false;

  const handleA = openSync(first, 'r');
  const handleB = openSync(second, 'r');
  const bufferA = Buffer.allocUnsafe(CHUNK_SIZE);
  const bufferB = Buffer.allocUnsafe(CHUNK_SIZE);

  try {
    let offset = 0;
    while (offset < size) {
      const length = Math.min(CHUNK_SIZE, size - offset);
      const readA = readSync(handleA, bufferA, 0, length, offset);
      const readB = readSync(handleB, bufferB, 0, length, offset);
      if (readA !== readB || readA === 0) return false;
      if (!bufferA.subarray(0, readA).equals(bufferB.subarray(0, readB))) return false;
      offset += readA;
    }
    return true;
  } finally {
    closeSync(handleA);
    closeSync(handleB);
  }
}

function detectTriple(): string {
  try {
    const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const line = output.split(/\r?\n/).find((item) => item.startsWith('host:'));
    if (line) return line.slice('host:'.length).trim();
  } catch {
    // rustc 不在 PATH 时退回默认值，并在下面给出提示
  }
  return FALLBACK_TRIPLE;
}

function main(): void {
  if (!existsSync(SOURCE)) {
    console.error(`未找到 sidecar 产物：${SOURCE}\n请先执行：bun run build:exe`);
    process.exit(1);
  }

  const triple = detectTriple();
  const destination = join(DEST_DIR, `scoop-manager-${triple}.exe`);

  mkdirSync(DEST_DIR, { recursive: true });

  const size = (statSync(SOURCE).size / 1024 / 1024).toFixed(1);
  const unchanged = existsSync(destination) && isSameFile(SOURCE, destination);
  if (unchanged) {
    console.log('sidecar 内容未变，跳过复制（保持 mtime）');
  } else {
    copyFileSync(SOURCE, destination);
    console.log('sidecar 已同步');
  }
  console.log(`  目标三元组  ${triple}`);
  console.log(`  输出        ${destination}`);
  console.log(`  体积        ${size} MB`);
}

main();
