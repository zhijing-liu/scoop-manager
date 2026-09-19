/**
 * 把可分发产物收拢到仓库根目录的 `release/`。
 *
 * 收集两类产物，它们对应两种完全不同的使用方式：
 *
 *   1. NSIS 安装包（desktop/target/release/bundle/nsis/）
 *      桌面应用：托盘常驻、不占用任何端口
 *   2. 单文件 exe（dist/scoop-manager.exe）
 *      服务模式：双击即启动本地 Web 服务并打开浏览器，也可交给 pm2
 *
 * Tauri 默认把安装包埋在 target/release/bundle/nsis 里，层级深且与构建中间产物
 * 混在一起；发布时只关心最终产物，因此统一收拢到一处，并顺手给单文件 exe 换成
 * 一眼能看出用途的名字。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const BUNDLE_DIR = join(ROOT, 'desktop', 'target', 'release', 'bundle', 'nsis');
const PORTABLE_SOURCE = join(ROOT, 'dist', 'scoop-manager.exe');
const OUT_DIR = join(ROOT, 'release');

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function report(target: string): void {
  const size = (statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`  ${target}  (${size} MB)`);
}

function main(): void {
  if (!existsSync(BUNDLE_DIR)) {
    console.error(`未找到构建产物目录：${BUNDLE_DIR}\n请先执行：bun run desktop:release（它已包含构建步骤）`);
    process.exit(1);
  }

  const installers = readdirSync(BUNDLE_DIR).filter((name) => name.toLowerCase().endsWith('.exe'));
  if (installers.length === 0) {
    console.error(`产物目录中没有找到安装包：${BUNDLE_DIR}`);
    process.exit(1);
  }

  // 每次重新收集，避免 release/ 里堆积历史版本导致误发
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const version = readVersion();
  console.log('产物已收拢到 release/');

  for (const name of installers) {
    const target = join(OUT_DIR, name);
    copyFileSync(join(BUNDLE_DIR, name), target);
    report(target);
  }

  if (existsSync(PORTABLE_SOURCE)) {
    const target = join(OUT_DIR, `scoop-manager-portable-${version}.exe`);
    copyFileSync(PORTABLE_SOURCE, target);
    report(target);
  } else {
    console.warn(`  提示：未找到 ${PORTABLE_SOURCE}，跳过单文件 exe（只发布桌面安装包）`);
  }
}

main();
