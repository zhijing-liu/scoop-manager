/**
 * 单文件 exe 打包脚本。
 *
 * 用 `bun run build:exe` 调用（即 `bun run scripts/build-exe.ts`）。
 *
 * 要点：
 *   1. 通过 compile.assets 把整个 public/ 目录树内嵌进可执行文件，
 *      运行时由 src/server/static.ts 从 Bun.embeddedFiles 兜底读取，
 *      因此 exe 可以脱离项目目录独立运行（真正的单文件分发）。
 *   2. naming.asset 固定为 [name].[ext]，避免 Bun 默认追加内容哈希，
 *      让内嵌路径与开发态路径保持一致，方便排障。
 *   3. Windows 元数据（图标 / 标题 / 版本）依赖 Windows API，只能在本机为
 *      Windows 目标编译时写入；跨平台交叉编译时自动跳过并给出提示。
 *   4. 输出固定为 dist/scoop-manager.exe。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const ENTRY = join(ROOT, 'src', 'index.ts');
const PUBLIC_DIR = join(ROOT, 'public');
const OUT_DIR = join(ROOT, 'dist');
const OUTFILE = join(OUT_DIR, 'scoop-manager.exe');

/** 可选图标：放到 assets/icon.ico 即会被自动使用。 */
const ICON_CANDIDATES = [join(ROOT, 'assets', 'icon.ico'), join(ROOT, 'build', 'icon.ico')];

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  author?: string;
}

function readPackageJson(): PackageJson {
  const file = join(ROOT, 'package.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return {};
  }
}

function pickIcon(): string | null {
  for (const candidate of ICON_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

async function main(): Promise<void> {
  if (typeof Bun === 'undefined') {
    console.error('此脚本必须在 Bun 下运行：bun run build:exe');
    process.exit(1);
  }

  if (!existsSync(ENTRY)) {
    console.error(`入口文件不存在: ${ENTRY}`);
    process.exit(1);
  }
  if (!existsSync(join(PUBLIC_DIR, 'index.html'))) {
    console.error(`静态资源目录不完整（缺少 index.html）: ${PUBLIC_DIR}`);
    process.exit(1);
  }

  const pkg = readPackageJson();
  const version = pkg.version ?? '1.0.0';
  const icon = pickIcon();
  const isWindowsHost = process.platform === 'win32';

  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(OUTFILE)) rmSync(OUTFILE, { force: true });

  console.log('Scoop Manager · 单文件打包');
  console.log(`  入口      ${ENTRY}`);
  console.log(`  静态资源  ${PUBLIC_DIR}`);
  console.log(`  输出      ${OUTFILE}`);
  console.log(`  目标      bun-windows-x64`);
  console.log(`  图标      ${icon ?? '未提供（跳过）'}`);
  console.log('');

  const started = Date.now();

  const result = await Bun.build({
    entrypoints: [ENTRY],
    // 顶层：控制代码生成
    minify: true,
    // 刻意不开 bytecode：Bun 的字节码预编译会把顶层 import.meta 视为
    // "非模块上下文"而在启动时抛 SyntaxError（import.meta is only valid
    // inside modules），而 src/server/static.ts 需要用 import.meta 定位
    // 内嵌资源目录。体积换来的那点启动收益不值这个坑。
    bytecode: false,
    // 资源保留原名，便于 static.ts 用固定路径查找
    naming: { asset: '[name].[ext]' },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    compile: {
      target: 'bun-windows-x64',
      outfile: OUTFILE,
      assets: [PUBLIC_DIR],
      autoloadDotenv: false,
      autoloadBunfig: false,
      // Windows 元数据依赖 Windows API，跨平台交叉编译时会被忽略，
      // 因此仅在 Windows 主机上填写，避免打包器报错。
      ...(isWindowsHost
        ? {
            windows: {
              ...(icon ? { icon } : {}),
              title: 'Scoop Manager',
              publisher: pkg.author && pkg.author.length > 0 ? pkg.author : 'scoop-manager',
              version,
              description: pkg.description ?? 'Scoop 的 Web GUI 管理器',
              copyright: `MIT Licensed · ${new Date().getFullYear()}`,
            },
          }
        : {}),
    },
  });

  if (!result.success) {
    console.error('打包失败：');
    for (const log of result.logs) console.error(`  ${log.message}`);
    process.exit(1);
  }

  if (!isWindowsHost) {
    console.warn('提示：当前主机不是 Windows，已跳过 exe 图标与版本信息写入。');
  }

  const size = existsSync(OUTFILE) ? statSync(OUTFILE).size : 0;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log(`打包完成（${elapsed}s）`);
  console.log(`  ${OUTFILE}`);
  if (size > 0) console.log(`  体积 ${humanSize(size)}`);
  console.log('');
  console.log('运行方式：双击 exe，或执行 dist\\scoop-manager.exe --port 3000');
  console.log('首启动会探测本机 Scoop；未安装时可在页面上一键安装或指定已有路径。');
  console.log(`数据目录：${join(homedir(), '.scoop-manager')}（可用 SCOOP_MANAGER_HOME 覆盖）`);
}

main().catch((error: unknown) => {
  console.error(`打包过程出错：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
