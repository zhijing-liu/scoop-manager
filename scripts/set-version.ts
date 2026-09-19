/**
 * 把版本号同步到所有需要它的地方。
 *
 * 版本在本项目里散落在四处，漏掉任何一处都会出现「安装包叫 1.2.0、界面显示
 * 1.0.0、exe 属性里又是另一个版本」这种不一致：
 *
 *   package.json                 发布元数据；build-exe.ts 据此写入 exe 的 Windows 版本资源
 *   src/config.ts (APP_VERSION)  /api/health 与界面顶部显示的版本
 *   desktop/tauri.conf.json      NSIS 安装包文件名、外壳的版本资源
 *   desktop/Cargo.toml           外壳二进制自身的版本
 *
 * 采用「按正则替换单点」而不是 JSON 反序列化再序列化，是为了不重排原有格式、
 * 把 diff 控制在一行以内。
 *
 * 用法：
 *   bun run version:set 1.2.3
 *   bun run version:set v1.2.3        # 前缀 v 会自动去掉
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

/** 允许可选的预发布后缀，例如 1.2.3-beta.1 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

interface Target {
  file: string;
  label: string;
  pattern: RegExp;
  replace: (version: string) => string;
}

const TARGETS: Target[] = [
  {
    file: 'package.json',
    label: 'package.json',
    // 第一个 "version" 就是顶层字段（前面只有 name）
    pattern: /^(\s*)"version":\s*"[^"]*"/m,
    replace: (version) => `$1"version": "${version}"`,
  },
  {
    file: 'src/config.ts',
    label: 'src/config.ts (APP_VERSION)',
    pattern: /export const APP_VERSION = '[^']*';/,
    replace: (version) => `export const APP_VERSION = '${version}';`,
  },
  {
    file: 'desktop/tauri.conf.json',
    label: 'desktop/tauri.conf.json',
    pattern: /^(\s*)"version":\s*"[^"]*"/m,
    replace: (version) => `$1"version": "${version}"`,
  },
  {
    file: 'desktop/Cargo.toml',
    label: 'desktop/Cargo.toml',
    // Cargo.toml 里第一个 `version = "..."` 属于 [package]，后面的段没有该字段
    pattern: /^version = "[^"]*"/m,
    replace: (version) => `version = "${version}"`,
  },
];

function main(): void {
  const raw = process.argv[2]?.trim() ?? '';
  const version = raw.replace(/^v/, '');

  if (!version) {
    console.error('用法：bun run version:set <版本号>，例如 bun run version:set 1.2.3');
    process.exit(1);
  }
  if (!VERSION_PATTERN.test(version)) {
    console.error(`版本号格式不合法：${raw}\n期望形如 1.2.3 或 1.2.3-beta.1`);
    process.exit(1);
  }

  console.log(`设置版本号：${version}\n`);

  let failed = false;

  for (const target of TARGETS) {
    const path = join(ROOT, target.file);
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch (error) {
      console.error(`  [缺失] ${target.label} — ${(error as Error).message}`);
      failed = true;
      continue;
    }

    if (!target.pattern.test(source)) {
      // 匹配不到说明文件结构被改过，静默跳过会导致版本不一致，必须报错
      console.error(`  [未匹配] ${target.label} — 没有找到可替换的版本字段，请检查该文件格式`);
      failed = true;
      continue;
    }

    const next = source.replace(target.pattern, target.replace(version));
    if (next === source) {
      console.log(`  [已是最新] ${target.label}`);
      continue;
    }

    writeFileSync(path, next);
    console.log(`  [已更新] ${target.label}`);
  }

  if (failed) {
    console.error('\n存在未处理的文件，版本号没有被完整同步。');
    process.exit(1);
  }

  console.log('\n完成。注意：Cargo.toml 变更会让下次 release 构建重新编译一次外壳。');
}

main();
