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
 *
 * 只收拢**当前版本**的安装包：
 *   Tauri 不会清理上次构建留下的安装包，于是 bundle 目录里可能同时存在
 *   `Scoop Manager_1.0.0_x64-setup.exe` 与 `..._1.1.0_...` —— 旧实现把目录里
 *   所有 .exe 都拷进 release/，等于把历史版本又搬了回来（清空 release/ 也没用），
 *   而 CI 的产物校验要求"恰好一个安装包"，会直接失败。
 *   这里按 package.json 的版本号筛选，并把过期产物从 bundle 目录里删掉。
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

/**
 * Tauri 的 NSIS 安装包命名：`<产品名>_<版本>_<架构>-setup.exe`。
 * 用它把「本次构建的产物」和「上次构建留下的」区分开。
 */
const SETUP_PATTERN = /^(?<product>.+)_(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_(?<arch>[^-]+)-setup\.exe$/i;

interface Classified {
  current: string[];
  stale: string[];
  unknown: string[];
}

/** 按版本号把 bundle 目录里的安装包分成三堆：本次的、过期的、命名不符合约定的。 */
function classifyInstallers(names: string[], version: string): Classified {
  const result: Classified = { current: [], stale: [], unknown: [] };
  for (const name of names) {
    const matched = SETUP_PATTERN.exec(name);
    if (!matched?.groups) {
      result.unknown.push(name);
      continue;
    }
    if (matched.groups.version === version) result.current.push(name);
    else result.stale.push(name);
  }
  return result;
}

function main(): void {
  if (!existsSync(BUNDLE_DIR)) {
    console.error(`未找到构建产物目录：${BUNDLE_DIR}\n请先执行：bun run desktop:release（它已包含构建步骤）`);
    process.exit(1);
  }

  const version = readVersion();
  const all = readdirSync(BUNDLE_DIR).filter((name) => name.toLowerCase().endsWith('.exe'));
  const { current, stale, unknown } = classifyInstallers(all, version);

  if (current.length === 0) {
    console.error(
      `产物目录中没有找到 ${version} 的安装包：${BUNDLE_DIR}\n` +
        `目录内的 .exe：${all.length > 0 ? all.join('、') : '（空）'}\n` +
        '若是首次构建，请先执行：bun run desktop:release',
    );
    process.exit(1);
  }

  // 清掉上次构建留下的安装包：它们既不该被收拢，也不该继续占着磁盘
  for (const name of stale) {
    rmSync(join(BUNDLE_DIR, name), { force: true });
    console.log(`已清理过期产物：${name}`);
  }
  if (unknown.length > 0) {
    console.warn(`  跳过命名不符合 <产品名>_<版本>_<架构>-setup.exe 约定的文件：${unknown.join('、')}`);
  }

  // 每次重新收集，避免 release/ 里堆积历史版本导致误发
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`产物已收拢到 release/（版本 ${version}）`);

  for (const name of current) {
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
