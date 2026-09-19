# Scoop Manager

面向 Windows 的 **Scoop 图形化管理器**。它在本地启动一个 Web 服务，把 Scoop 的命令行能力全部搬到浏览器里：检测环境、搜索安装、更新卸载、管理 Bucket 与配置代理，全部以简体中文界面完成，长耗时操作带 **实时日志流** 与 **随时取消**。

- 同一套 TypeScript 代码，**Node 18+ 与 Bun 1.x 双运行时** 均可启动
- 前端 Alpine.js **本地内置、零构建步骤、完全离线可用**
- 可打包为 **单文件 exe**（静态资源内嵌），双击即用
- 也提供 **pm2 常驻** 方案
- 可打包为 **Windows 桌面应用**（Tauri 外壳 + 系统托盘常驻），**不占用任何端口**
- 不引入 Express、不引入日志框架：任务队列、SSE、日志缓冲全部自研

> ⚠️ 本工具**不做任何鉴权**，默认只监听 `127.0.0.1`。如需对外暴露，请自行在反向代理层加访问控制，切勿直接暴露到公网。

---

## 快速开始

### 方式一：直接运行源码（开发）

```bash
# 安装依赖
pnpm install

# Bun（推荐，直接跑 TS）
pnpm run dev

# 或 Node + tsx（热重载）
pnpm run dev:node
```

启动后终端会打印访问地址（默认 <http://127.0.0.1:3000>），并自动打开浏览器。

### 方式二：Node 构建后运行（生产）

```bash
pnpm install
pnpm run build      # tsc 输出到 dist/
pnpm start          # node dist/index.js
```

### 方式三：打包单文件 exe

需要安装 [Bun](https://bun.sh)。

```bash
pnpm install
pnpm run build:exe
```

产物为 `dist/scoop-manager.exe`，`public/` 整个目录树已内嵌其中，**可单独拷贝到任意机器运行**，无需 Node/Bun 环境或项目文件。

### 方式四：pm2 常驻

```bash
pnpm run build          # 或跳过，使用 bun app 定义
pnpm run pm2:start      # 等价于 pm2 start ecosystem.config.cjs
pnpm run pm2:logs
pnpm run pm2:stop
```

`ecosystem.config.cjs` 内置两个 app：`scoop-manager`（Node 跑 `dist/index.js`）与 `scoop-manager-bun`（Bun 直接跑 `src/index.ts`），二选一即可。

### 方式五：打包为 Windows 桌面应用

需要额外安装 [Rust](https://rustup.rs)（Tauri 的外壳是 Rust 写的）。

```bash
pnpm install
pnpm run desktop:release   # 一条命令走完：编译 sidecar → 生成图标与静态资源 → 打包 → 收拢到 release/
```

需要更细的控制时可以拆开用：

| 命令 | 做什么 |
| --- | --- |
| `pnpm run desktop:prep` | 只做前置：编译 exe、同步 sidecar、生成 `desktop/ui/` 与图标。**内容未变时自动跳过，不会刷新 mtime**，因此不会无谓地触发 Rust 重编译 |
| `pnpm run desktop:build` | `desktop:prep` + `tauri build`，产出 NSIS 安装包 |
| `pnpm run desktop:collect` | 只把安装包复制到 `release/`，不重新构建（构建已完成、只是收集失败时用） |
| `pnpm run desktop:release` | `desktop:build` + `desktop:collect` |

产物：`release/Scoop Manager_x.y.z_x64-setup.exe`，按当前用户安装（无需管理员权限）。

桌面版与前面的服务模式**完全隔离**：

| | 服务模式 | 桌面应用 |
| --- | --- | --- |
| 传输 | HTTP，监听 TCP 端口 | stdin/stdout 二进制分帧，**零端口** |
| 页面来源 | Hono 提供（内嵌或磁盘 `public/`） | Tauri 提供（`desktop/ui/`） |
| 数据目录 | `%USERPROFILE%\.scoop-manager` | `%USERPROFILE%\.scoop-manager-desktop` |
| 生命周期 | 自主进程 / pm2 | 随外壳，由托盘控制 |
| 浏览器访问 | 支持 | 不适用（没有端口） |

桌面版要点：关闭窗口即最小化到托盘；托盘提供「显示主界面 / 重启服务 / 开机自启动 / 查看日志 / 打开数据目录 / 退出」；退出时先请 sidecar 落盘任务历史再结束进程。

### 方式六：交给 GitHub Actions 自动打包

仓库内置两条工作流，均运行在 `windows-latest`，一次产出两份形态不同的产物：

| 工作流 | 触发方式 | 内容 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push 到 `main`/`master`、PR、手动 | 类型检查 → 传输层自测（42 项断言）→ 生成桌面端前置资源 → **针对编译出的 exe 再跑一次协议自测** → Rust 静态检查 |
| `.github/workflows/release.yml` | 推送 `v*` tag、手动触发 | 同步版本号 → 自测 → 完整构建 → 校验安装包内容 → 上传 artifact；tag 触发时额外发布 GitHub Release |

产物：

| 文件 | 说明 |
| --- | --- |
| `Scoop Manager_<版本>_x64-setup.exe` | 桌面应用安装包（推荐）：托盘常驻、**不占用任何端口** |
| `scoop-manager-portable-<版本>.exe` | 单文件服务版：双击启动本地 Web 服务并自动打开浏览器，也可交给 pm2 |

发布新版本：

```bash
git tag v1.0.1
git push origin v1.0.1
```

版本号由工作流自动同步到 `package.json` / `src/config.ts` / `desktop/tauri.conf.json` / `desktop/Cargo.toml` 四处（本地可用 `pnpm run version:set 1.0.1` 做同样的事）。

只想先拿一份可安装的包、暂时不发布 Release，就手动触发 release 工作流并填版本号——产物会作为 artifact 上传。

> CI 使用的包管理器是 **bun**（`bun install --frozen-lockfile`）。仓库里同时存在 `bun.lock` 与 `pnpm-lock.yaml`，Tauri CLI 会就此给出警告；建议后续二选一，删掉不用的那个。

---

## 命令行参数

| 参数 | 说明 |
| --- | --- |
| `-p, --port <端口>` | 监听端口，默认 `3000`；被占用时自动向后寻找可用端口 |
| `--host <地址>` | 监听地址，默认 `127.0.0.1` |
| `--scoop-path <路径>` | 手动指定 Scoop 根目录（写入应用配置） |
| `--base-path <路径>` | 反向代理子路径，例如 `/scoop`；留空表示部署在根路径 |
| `--log-level <级别>` | `debug` / `info` / `warn` / `error`，默认 `info` |
| `--open` / `--no-open` | 启动后是否自动打开浏览器（默认打开） |
| `--rpc <模式>` | `stdio` 表示改用 stdin/stdout 分帧传输且**不监听任何端口**（桌面端 sidecar 专用） |
| `--parent-pid <pid>` | 指定的父进程退出后本进程自动关闭（桌面端专用，用于避免孤儿进程） |
| `--no-persist` | 本次命令行覆盖不写回配置文件（桌面端专用） |
| `-v, --version` | 显示版本号 |
| `-h, --help` | 显示帮助 |

支持 `--port=3000` 或 `--port 3000` 两种写法。

---

## 部署到反向代理（子路径）

支持把界面挂在 `/scoop/` 之类的子路径下。**前端资源用相对路径、接口前缀由服务端注入**，因此同一份构建产物（含 exe）可以部署在任意前缀，换前缀不需要重新打包。

服务端同时兼容两种代理写法：

| 代理写法 | 后端收到 | 需要做什么 |
| --- | --- | --- |
| **剥离前缀** `proxy_pass http://127.0.0.1:3000/;`（末尾有 `/`） | `/api/health` | 代理补一个 `X-Forwarded-Prefix` 请求头告知对外前缀 |
| **透传前缀** `proxy_pass http://127.0.0.1:3000;`（末尾无 `/`） | `/scoop/api/health` | 启动时加 `--base-path /scoop` |

> 不加任何配置也能工作 —— 此时程序假定自己部署在根路径，界面里的资源与接口都会指向 `/`。

### nginx（剥离前缀 + 请求头）

```nginx
location = /scoop { return 301 /scoop/; }

location /scoop/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 关键：告知实际对外前缀，前端据此拼接口地址
    proxy_set_header X-Forwarded-Prefix /scoop;

    # SSE（实时日志）必须关闭缓冲，否则日志会攒到最后一次性吐出
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

### nginx（透传前缀）

```nginx
location /scoop/ {
    proxy_pass http://127.0.0.1:3000;   # 注意：末尾没有斜杠
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

对应的启动命令：

```bash
scoop-manager.exe --base-path /scoop
```

### Caddy

```caddy
example.com {
    handle_path /scoop/* {
        reverse_proxy 127.0.0.1:3000
    }
}
```

`handle_path` 会剥离前缀，所以启动时不需要（也不应该）加 `--base-path`；若同时想显式声明，可加请求头：

```caddy
example.com {
    handle /scoop/* {
        reverse_proxy 127.0.0.1:3000 {
            header_up X-Forwarded-Prefix /scoop
        }
    }
}
```

### 要点

- **SSE 必须关闭代理缓冲**（`proxy_buffering off`），否则「实时日志」会失去实时性。
- 子路径下**启动前缀**是 `/scoop/`，程序会自动把 `/scoop`（无尾斜杠）308 跳到 `/scoop/`，保证相对资源能正确解析。
- 反向代理不会带来鉴权。本工具没有任何认证，请务必在代理层加上访问控制（`auth_basic`、IP 白名单、SSO 等）。
- 可用 `GET /api/health` 的 `basePath` 字段确认当前生效的前缀。

---

## 功能清单

| 模块 | 能力 |
| --- | --- |
| **环境概览** | Scoop 安装检测、版本、`SCOOP` / `SCOOP_GLOBAL` 路径、PowerShell 类型、执行策略、环境体检；四项关键指标与可用更新列表；一键体检 / 更新 Scoop / 导出 Scoopfile / 清理缓存 |
| **已安装应用** | 名称 / 版本 / 来源 / 更新时间 / 锁定状态列表；详情抽屉（描述、主页、安装路径、Shim、依赖、原始 manifest）；单个与批量更新、卸载（可选彻底清理）、锁定 / 解锁、重置 |
| **搜索与安装** | 基于本地 Bucket 清单的**毫秒级离线搜索**（可按 Bucket 过滤）；安装选项面板（全局 / 独立 / 跳过哈希 / 不用缓存 / 指定架构）、依赖预览、将执行命令预览 |
| **Bucket 管理** | 已添加 Bucket 列表（仓库来源、清单数、更新时间、官方标记）；添加 / 删除 / 更新；官方已知 Bucket 推荐一键添加；跳转到该 Bucket 搜索 |
| **配置与代理** | 全部配置项读写（敏感值打码）；代理设置 / 跟随系统 / 清除 / **连通性测试（返回延迟）**；常用键快捷卡片（aria2、并发数、缓存路径等） |
| **任务与日志** | 任务列表（状态、耗时、退出码）；终端式实时日志（stdout/stderr 分色、时间戳、自动滚动、复制、下载）；取消任务、失败重试、清理历史 |
| **首次引导** | 未检测到 Scoop 时弹出向导：**一键安装**（官方脚本，可选管理员）或 **指定已有路径**（校验后接入） |

---

## 工作原理（简述）

Scoop 官方**没有**通用的 `--json` 开关，文本表格格式不稳定、解析极易随版本失效。因此本工具采取 **「读走文件系统，写走 CLI」** 策略：

- **读**：已安装应用扫描 `<SCOOP>/apps/*/current/manifest.json`；搜索扫描 `<SCOOP>/buckets/*/bucket/*.json` 建内存索引；配置直接解析 `config.json`
- **写**：`install` / `uninstall` / `update` / `hold` / `cleanup` / `bucket add|rm` / `config set|rm` 等全部通过 PowerShell 调用 `scoop.ps1`

安全性上：命令**绝不使用 `shell: true`**，参数以单引号包裹并对 `'` 转义；所有用户输入先经过白名单正则校验；变更类操作**串行排队**（Scoop 自身并发不安全）。

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 目录结构

```
scoop-manager/
├── package.json              # 脚本与依赖声明
├── tsconfig.json             # ESM + NodeNext，仅引入 node 类型
├── ecosystem.config.cjs      # pm2 配置（node / bun 双 app）
├── scripts/
│   ├── build-exe.ts          # Bun 单文件打包（内嵌 public/、写入 Windows 元数据）
│   ├── build-ui.ts           # 生成桌面端静态资源 desktop/ui/（替换 __BASE_PATH__）
│   ├── sync-sidecar.ts       # 把 exe 按 Tauri externalBin 命名同步到 desktop/binaries/
│   ├── make-icon.ts          # 零依赖生成占位图标集（ICO + PNG）
│   ├── collect-release.ts    # 把 NSIS 安装包收拢到 release/
│   └── rpc-selftest.ts       # IPC 协议自测（20 项断言，作为传输层硬闸门）
├── src/
│   ├── index.ts              # 入口：唯一的模式分派点（服务模式 / 应用模式）
│   ├── modes/                # 两种运行形态的启动器：bootstrap / service / desktop
│   ├── config.ts             # 应用自身配置（~/.scoop-manager/config.json）
│   ├── runtime.ts            # 运行时信息（kind / transport / host / port）
│   ├── server/               # Hono 应用组装、Bun/Node/IPC 适配器、静态资源、错误模型
│   ├── routes/               # health / scoop / buckets / apps / search / config / jobs
│   ├── services/             # scoop 定位、PowerShell、命令执行、manifest 索引、配置、缓存
│   ├── jobs/                 # 任务契约、状态机 + 环形缓冲、串行队列、执行桥接
│   └── utils/                # logger / validate / fsx / net / paths / parent-guard
├── public/                   # 前端（无构建步骤）
│   ├── index.html            # SPA 骨架：侧栏 + 顶栏 + 视图容器 + 状态条
│   ├── css/style.css         # 暗色开发者控制台主题
│   ├── vendor/alpine.min.js  # Alpine.js 本地内置
│   └── js/                   # api / sse / format / main + views/*（6 个视图）
├── desktop/                  # Tauri 桌面外壳（Rust）
│   ├── tauri.conf.json       # 窗口默认值、externalBin、NSIS 打包配置
│   ├── src/                  # lib / bridge（分帧） / server（进程） / tray（托盘）
│   ├── shim/ipc-shim.js      # 注入式垫片：替换 fetch 与 EventSource
│   ├── icons/                # 应用图标（占位，可覆盖）
│   ├── ui/                   # 由 build-ui.ts 生成（gitignore）
│   └── binaries/             # 由 sync-sidecar.ts 生成（gitignore）
├── release/                  # 安装包输出目录（gitignore）
└── docs/                     # 使用说明、API 文档、架构说明、排障手册
```

---

## 文档

- [docs/USAGE.md](docs/USAGE.md) —— 首次引导与各页面操作、常见工作流
- [docs/API.md](docs/API.md) —— 全部接口契约、请求 / 响应示例、错误码表
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 分层设计、任务与 SSE 机制、关键取舍
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) —— 未装 Scoop、执行策略、乱码、权限、端口、代理等问题排查

---

## 开发脚本一览

| 命令 | 说明 |
| --- | --- |
| `pnpm run dev` | Bun 直接运行源码 |
| `pnpm run dev:node` | tsx watch 运行源码 |
| `pnpm run typecheck` | `tsc --noEmit` 类型检查 |
| `pnpm run build` | 编译到 `dist/` |
| `pnpm start` | Node 运行编译产物 |
| `pnpm run build:exe` | 打包单文件 exe（需 Bun） |
| `pnpm run test` | 跑全部自测（`test:ipc` + `test:shim`） |
| `pnpm run test:ipc` | IPC 协议自测（接受可选的 `.exe` 路径参数，用于验证编译产物） |
| `pnpm run test:shim` | 垫片自测（用 stub 在 Bun 里求值 `ipc-shim.js`，覆盖 EventSource 与 fetch 代理） |
| `pnpm run desktop:prep` | 桌面端全部前置（exe → sidecar → ui → 图标），内容未变时自动跳过 |
| `pnpm run desktop:dev` | 启动桌面端开发态（Tauri dev，debug 构建） |
| `pnpm run desktop:build` | 打包桌面端安装包（自动先跑 prep） |
| `pnpm run desktop:collect` | 只把安装包收拢到 `release/`，不重新构建 |
| `pnpm run desktop:release` | 完整发布：`desktop:build` + 收拢到 `release/` |
| `pnpm run version:set <版本>` | 把版本号同步到 `package.json` / `src/config.ts` / `tauri.conf.json` / `Cargo.toml` |
| `pnpm run pm2:start` / `pm2:stop` / `pm2:logs` | pm2 启停与日志 |

---

## 运行环境

- **操作系统**：Windows 10 / 11 / Server 2016+（Scoop 本身仅支持 Windows）
- **PowerShell**：Windows PowerShell 5.1 或 PowerShell 7+（优先 `pwsh`）
- **运行时**：Node.js ≥ 18 或 Bun ≥ 1.1
- 非 Windows 平台下服务仍可启动，界面可访问，但所有 Scoop 操作会返回明确的中文错误提示

## License

MIT
