/**
 * Tauri CLI 的启动包装。
 *
 * 为什么需要它
 * ────────────
 * cargo / rustc 装在 `%USERPROFILE%\.cargo\bin`，而这个目录是**安装 Rust 时才**
 * 写进用户 PATH 的。任何在安装之前就已启动的终端 —— 包括 IDE 的内置终端 ——
 * 都拿不到它，于是 tauri CLI 会在启动瞬间报：
 *
 *   failed to run 'cargo metadata' command to get workspace directory:
 *   failed to run command cargo metadata --no-deps --format-version 1: program not found
 *
 * 这个报错与项目本身毫无关系，却极易被误判成配置问题。这里显式把 Rust 工具链
 * 目录补进子进程 PATH，让 desktop:dev / desktop:build 不受终端环境影响。
 *
 * 用法：bun run scripts/tauri.ts <子命令> [参数...]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

/** 需要补进 PATH 的候选目录，按优先级排列 */
function toolchainDirs(): string[] {
  const dirs: string[] = [];
  const cargoHome = process.env['CARGO_HOME'];
  const rustupHome = process.env['RUSTUP_HOME'];

  if (cargoHome) dirs.push(join(cargoHome, 'bin'));
  dirs.push(join(homedir(), '.cargo', 'bin'));
  if (rustupHome) dirs.push(join(rustupHome, 'bin'));
  return dirs;
}

function augmentedPath(): string {
  const existing = (process.env['PATH'] ?? '').split(delimiter);
  const extra = toolchainDirs().filter((dir) => existsSync(dir) && !existing.includes(dir));
  return [...extra, ...existing].join(delimiter);
}

/**
 * 选择加载 Tauri CLI 的 node。
 *
 * 不能直接用 `npm_node_execpath`：`bun run` 也会设置这个变量，但值是 bun 本体。
 * Tauri CLI 是 node 的 napi 原生模块，用真正的 node 加载最稳，因此只在它确实是
 * node 时才采用，否则回退到 PATH 上的 node。
 */
function resolveNodeRuntime(): string {
  const candidate = process.env['npm_node_execpath'];
  if (candidate && /^node(\.exe)?$/i.test(basename(candidate))) return candidate;
  return 'node';
}

function resolveLauncher(): { command: string; prefix: string[] } {
  const cliEntry = resolve(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (existsSync(cliEntry)) {
    return { command: resolveNodeRuntime(), prefix: [cliEntry] };
  }
  return { command: 'tauri', prefix: [] };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('用法：bun run scripts/tauri.ts <子命令> [参数...]');
    process.exit(1);
  }

  const path = augmentedPath();
  if (!path.split(delimiter).some((dir) => existsSync(join(dir, process.platform === 'win32' ? 'cargo.exe' : 'cargo')))) {
    console.error('未找到 cargo。请先安装 Rust 工具链：');
    console.error('  winget install Rustlang.Rustup');
    console.error('  rustup default stable-msvc');
    process.exit(1);
  }

  const { command, prefix } = resolveLauncher();
  const child = spawn(command, [...prefix, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PATH: path },
    // 退回全局 tauri 时它是个 .cmd/.bat，需要 shell 才能执行
    shell: command === 'tauri',
  });

  child.on('error', (error) => {
    console.error(`无法启动 Tauri CLI（${command}）：${error.message}`);
    if (command === 'node') {
      console.error('本项目需要 Node.js：@tauri-apps/cli 是 node 原生模块。安装：https://nodejs.org');
    }
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
