/**
 * 安装残骸清理。
 *
 * 这是 Scoop 自身的一处死锁，官方命令无解：
 *
 *   - `scoop status` 按**目录遍历**：只要 `apps\<name>` 在，就把它列出来，
 *     并因为读不到 `install.json`（或没有 `current`）而标成 `Install failed`；
 *   - `scoop uninstall` 却以 **install.json** 为准，判定"未安装"，于是只打印
 *     `ERROR '<name>' isn't installed.` 什么都不做 —— 而且 Scoop 的 `error()`
 *     只打印不退出（见 lib/core.ps1），退出码还是 0，于是整件事看起来像"卸载成功"。
 *
 * 结果就是「我已经卸载了，但 status 里还有」。
 *
 * 这里按 Scoop 自己卸载时相同的方式清理：删应用目录、删该应用留下的 shim，
 * 需要时再删 persist 数据。**只对残骸生效**：正常安装的应用必须走
 * `scoop uninstall`，不允许借这条路径绕过 Scoop。
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './errors.js';
import { createLogger } from './logger.js';
import { detectScoop } from './locator.js';

const logger = createLogger('remains');

/**
 * shim 的落地形态。
 *
 * 目标是 exe 时 Scoop 只生成 `<name>.exe`（通用的 shim.exe 副本）+ `<name>.shim`
 * （写明 `path = "…\apps\<app>\current\xxx.exe"`）；目标是脚本时才会有 .cmd / .ps1。
 * 这里把可能存在的形态都清掉，避免删了 .shim 却留下一个指向空路径的 shim.exe。
 */
const SHIM_SUFFIXES = ['.shim', '.exe', '.cmd', '.ps1', '.bat', ''];

export interface RemainsCleanupResult {
  name: string;
  appDir: string;
  removedShims: string[];
  removedPersist: string[];
}

/**
 * 判定应用目录是否是「残骸」：目录在，但 `current\install.json` 读不出来。
 * 与 Scoop 的 `failed()` 判定一致（未启用 NO_JUNCTION 时精确）。
 */
function isRemains(appDir: string): boolean {
  if (!existsSync(appDir)) return false;
  try {
    const raw = readFileSync(join(appDir, 'current', 'install.json'), 'utf8');
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown;
    // 能读出对象就说明 install.json 是好的 —— 正常应用
    return !(parsed && typeof parsed === 'object');
  } catch {
    return true;
  }
}

/** 用户与全局两个根（去重）。 */
async function resolveRoots(): Promise<string[]> {
  const env = await detectScoop();
  if (!env.installed || !env.root) {
    throw new AppError('SCOOP_NOT_INSTALLED', '未检测到可用的 Scoop 安装。');
  }
  const roots = [env.root];
  if (env.globalRoot && env.globalRoot.toLowerCase() !== env.root.toLowerCase()) {
    roots.push(env.globalRoot);
  }
  return roots;
}

/**
 * 清理指定应用的安装残骸。
 *
 * @param name    应用名
 * @param options purge=true 时同时删除 `persist\<name>`（与 `scoop uninstall --purge` 一致）
 * @throws AppError 未找到目录（NOT_FOUND）、或该应用是正常安装（INVALID_PARAM）
 */
export async function cleanRemains(
  name: string,
  options: { purge?: boolean } = {},
): Promise<RemainsCleanupResult> {
  const purge = options.purge === true;

  // 硬保险：scoop 自身没有 install.json / manifest.json，形式上和残骸一模一样，
  // 但它显然不是残骸 —— 一旦被清理，整套 Scoop 就没了。
  if (name.toLowerCase() === 'scoop') {
    throw new AppError('INVALID_PARAM', 'scoop 自身是 git 安装的，不是安装残骸，不能清理。');
  }

  const roots = await resolveRoots();

  const appDir = roots.map((root) => join(root, 'apps', name)).find((dir) => existsSync(dir));
  if (!appDir) {
    throw new AppError('NOT_FOUND', `未找到应用目录 apps\\${name}，可能已经被清理。`);
  }
  if (!isRemains(appDir)) {
    throw new AppError(
      'INVALID_PARAM',
      `${name} 是正常安装的应用，请用「卸载」而不是清理残骸。`,
    );
  }

  // 1) 应用目录（含 current 链接与所有版本目录）
  rmSync(appDir, { recursive: true, force: true });

  // 2) 该应用留下的 shim：目标路径记录在同名 .shim 里
  const removedShims: string[] = [];
  const needle = `\\apps\\${name.toLowerCase()}\\`;
  for (const root of roots) {
    const shimsDir = join(root, 'shims');
    if (!existsSync(shimsDir)) continue;
    for (const file of readdirSync(shimsDir)) {
      if (!file.toLowerCase().endsWith('.shim')) continue;
      let content = '';
      try {
        content = readFileSync(join(shimsDir, file), 'utf8');
      } catch {
        continue; // 读不到就跳过，宁可少删也不要误删别人的 shim
      }
      if (!content.toLowerCase().includes(needle)) continue;

      const base = file.slice(0, -'.shim'.length);
      for (const suffix of SHIM_SUFFIXES) {
        const target = `${base}${suffix}`;
        const full = join(shimsDir, target);
        if (!existsSync(full)) continue;
        rmSync(full, { force: true });
        removedShims.push(target);
      }
    }
  }

  // 3) 可选的持久化数据
  const removedPersist: string[] = [];
  if (purge) {
    for (const root of roots) {
      const persistDir = join(root, 'persist', name);
      if (!existsSync(persistDir)) continue;
      rmSync(persistDir, { recursive: true, force: true });
      removedPersist.push(persistDir);
    }
  }

  logger.info(
    `已清理残骸 ${name}：${appDir}` +
      `${removedShims.length > 0 ? `，shim ${removedShims.length} 个` : ''}` +
      `${removedPersist.length > 0 ? '，persist 已删除' : ''}`,
  );

  return { name, appDir, removedShims, removedPersist };
}
