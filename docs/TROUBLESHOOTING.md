# 排障手册

按现象组织。每条包含「如何确认」与「如何处理」。

> **通用手段**：先用 `--log-level debug` 启动，日志会打印 HTTP 访问、静态资源解析结果、命令组装等细节。
>
> ```bash
> bun run dev -- --log-level debug
> ```
>
> 也可以在浏览器里打开 `http://127.0.0.1:<端口>/api/health`，一次性看到运行时、静态资源来源、Scoop 定位与任务计数。

---

## 1. 未检测到 Scoop

**现象**：进入页面即弹出首次引导；概览页顶部显示「需要配置 Scoop」；任何 Scoop 操作返回 `SCOOP_NOT_INSTALLED`。

**如何确认**

- `GET /api/scoop/env` 的 `installed` 为 `false`
- `issues` 数组里会给出具体原因，例如：
  - `未检测到可用的 Scoop 安装，请使用「一键安装」或「指定已有路径」。`
  - `已定位 Scoop 根目录 X，但未找到 scoop.ps1，请确认安装是否完整。`

**如何解决**

1. **一键安装**：概览页 →「一键安装 Scoop」，可指定目录；需要装到 `C:\ProgramData` 时勾选「以管理员身份安装」。
2. **指定已有路径**：如果你已把 Scoop 装在别处（例如 `D:\scoop`），填**根目录**接入即可（不是 `apps` 或 `shims`）。
3. **手工让程序看见**：把 `SCOOP` 环境变量指向 Scoop 根目录后重启程序，或用启动参数：

   ```bash
   scoop-manager.exe --scoop-path D:\scoop
   ```

**排查顺序**：`SCOOP` 环境变量 → `scoop config` 中的 `root_path` → 默认目录 `%USERPROFILE%\scoop`。程序按此顺序探测（`rootSource` 字段会告诉你最终命中哪一个）。

---

## 2. 提示「当前平台不受支持」

**现象**：顶部出现红色/黄色阻断提示，所有操作失败，错误码 `PLATFORM_UNSUPPORTED`。

**原因**：Scoop 本身只支持 Windows。程序在 Linux / macOS 上仍会启动（便于开发与演示），但所有 Scoop 功能不可用。

**处理**：在 Windows 上运行本程序。注意 WSL 里跑的是 Linux 环境，同样不支持 —— 请用 Windows 侧的 Node/Bun 运行。

---

## 3. 未找到 PowerShell

**现象**：错误码 `POWERSHELL_NOT_FOUND`；概览页「PowerShell」一项显示「未找到」。

**如何确认**

- `GET /api/health` 的 `scoop.powershell` 为 `null`
- 在终端确认 `pwsh -v` 或 `powershell -v` 可用

**处理**

- 安装 [PowerShell 7](https://github.com/PowerShell/PowerShell/releases)（推荐），或确保系统自带 Windows PowerShell 5.1 未被移除。
- 如果 PowerShell 装在非标准路径，请把它所在目录加入 `PATH` 后重启程序。

---

## 4. 执行策略受限

**现象**：概览页「执行策略」显示 `Restricted` 或 `AllSigned`，但操作仍然可用（可能伴随一条提示）。

**说明**：这是**预期行为**。本工具固定以 `-ExecutionPolicy Bypass` 调用 PowerShell，不会修改你的系统设置，因此无需手动改执行策略。

如果你**手动**修改过执行策略导致脚本被拦截，恢复默认即可：

```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

---

## 5. 日志乱码

**现象**：任务日志里出现 `����` 或乱序的中文字符。

**原因**：Windows PowerShell 5.1 在重定向输出时按 OEM 代码页（如 936 / 850）编码，而不是 UTF-8。

**程序已做的处理**：每次调用都会注入 prelude：

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
```

**仍然乱码时**

1. 确认是 **PowerShell 5.1** 而非 PowerShell 7（`path` 字段以 `WindowsPowerShell` 结尾）。安装 PowerShell 7 后程序会优先使用 `pwsh`，乱码问题基本消失。
2. 检查系统 `chcp` 是否为 65001：`chcp 65001`。
3. 通过 exe 运行时，确认你的终端不是以极老的代码页启动（`cmd /c chcp 65001` 后再运行）。

---

## 6. 全局安装 / 操作失败（权限不足）

**现象**：`scoop install -g` 或删除 Bucket 等操作失败，退出码非 0，日志里出现 `Access to the path ... is denied` 或 `requires elevation`。

**原因**：全局 Scoop 位于 `C:\ProgramData\scoop`，需要管理员权限。

**处理**

1. 以管理员身份运行 exe / 终端（右键 → 以管理员身份运行）。
2. `config.json` 不可写时也一样 —— 配置页底部会显示「不可写」，此时请以管理员身份重启程序。

**注意**：全局安装失败时，错误会被映射为中文提示，原始 stderr 保留在任务的「详情」里。

---

## 7. 端口被占用

**现象**：启动日志出现「端口 3000 已被占用，自动改用 3001」。

**说明**：这是**自动行为**，程序会从首选端口开始连续尝试最多 20 个端口。`GET /api/health` 的 `server.portShifted` 为 `true` 时表示发生过偏移。

**处理**

- 想让端口固定：`scoop-manager.exe --port 8123`
- 想监听所有网卡：`scoop-manager.exe --host 0.0.0.0`（⚠️ 不建议，本工具无鉴权）

---

## 8. 页面打不开 / 空白 / 样式丢失

**现象**：访问地址返回 JSON 404，或页面没有样式，或控制台报「Alpine.js 未能加载」。

**如何确认**

- `GET /api/health` → `static.source`
  - `none`：未找到静态资源，页面必然异常
  - `embedded`：来自 exe 内嵌资源
  - `disk`：来自磁盘目录（`static.dir` 会给出具体路径）

**处理**

- **开发态**：确保在项目根目录启动（`public/` 必须与 `package.json` 同级）。
- **Node 构建态**：确认 `dist/` 与 `public/` 都在，且没有单独拷贝 `dist/` 到别处。
- **exe 态**：说明打包时没有内嵌成功。请用 `bun run build:exe` 重新打包，并确认输出日志里有 `assets: ['public']`。
- **样式丢失**：检查 `public/css/style.css` 是否存在，以及浏览器 Network 面板里它的 HTTP 状态。
- **`Alpine.js 未能加载`**：确认 `public/vendor/alpine.min.js` 存在且未被安全软件或反向代理拦截。

---

## 9. 搜索没有结果 / 索引为空

**现象**：搜索页显示「还没有可搜索的应用清单」；概览页「可搜索应用」为 0。

**原因**：搜索基于本地 Bucket 中的 manifest 文件。没有 Bucket，或 Bucket 目录为空。

**处理**

1. 进入 **Bucket 管理**，添加 `main` / `extras`（推荐卡片一点即加）。
2. 添加完成后，搜索页点「重建索引」。
3. 若 Bucket 已存在但仍为空，检查 `<SCOOP>\buckets\<name>\bucket\` 目录下是否有 `.json` 文件。

---

## 10. 可更新列表为空，但实际有更新

**现象**：概览页「可用更新」为 0，某个应用其实已经有新版本。

**原因**：可更新列表是「已安装版本」与「**本地** bucket manifest 版本」比对的结果。本地 bucket 未更新时数据会滞后（页面上有明确提示）。

**处理**

1. 概览页点「更新 Bucket」（或到 Bucket 管理页点「更新全部」）。
2. 回到概览页点右上角「刷新」。
3. 仍然不对时，检查该应用是否处于**锁定（hold）**状态 —— 锁定不会影响列表展示，但 `scoop update` 会跳过它。
4. 也可以直接看「可用更新」标题旁的来源徽标：显示**本地索引**说明还没联网复核，点已安装页的「检查更新状态」即可。
5. 如果是在终端里直接 `scoop update` 过，见 [20. 界面数据与磁盘不一致](#20-界面数据与磁盘不一致在终端里操作过-scoop)。

---

## 11. 安装/更新卡住或极慢

**现象**：日志长时间没有新行；任务一直处于「执行中」。

**排查**

1. 看日志最后一行：通常停在下载环节（网络问题）或解压环节（杀毒软件扫描）。
2. 检查是否需要代理：进入 **配置与代理**，设置代理后点「测试连通性」确认延迟正常。
3. 试试「跳过缓存」（安装面板勾选 `-k`），排除损坏的缓存包。
4. 确认目标应用没有正在运行（Windows 上文件被占用会导致替换失败）。

**处理**

- 随时可点任务上的 🛑 **取消**，程序会杀掉整个进程树。
- 取消后建议先「清理旧版本」再重试。
- 若某项稳定超时，任务会以 `timeout` 终态结束，可用「重试」重新提交。

---

## 12. 代理测试失败

**现象**：配置与代理页「测试连通性」返回失败。

**按错误信息处理**

| 返回 | 含义 | 处理 |
| --- | --- | --- |
| `当前未配置代理` | 输入框和已保存配置都为空 | 先填代理地址 |
| `当前为「跟随系统代理」模式` | 值为 `current` | 该模式走系统设置，本工具无法直接测试，请在 Windows 设置 → 代理中确认 |
| `无法解析代理地址` | 格式不合法 | 使用 `127.0.0.1:7890` 或 `http://user:pass@host:port` |
| `连接超时` / `connection refused` | 端口不可达 | 确认代理软件已启动、端口正确、未被防火墙拦截 |

> 测试只做一次 TCP 握手，**不发送业务数据**，因此握手成功不代表代理能正常转发（如需端到端验证，可执行一次应用更新）。

---

## 13. 日志显示「更早的日志已超出缓冲上限被丢弃」

**说明**：这是**预期行为**。每个任务的环形缓冲保留最近 4000 行，超出部分会被丢弃以避免内存无限增长。

**处理**

- 需要完整记录时，在任务进行中或结束后点「下载」导出当前缓冲内容。
- 若确实需要更长日志，可调大 `jobs/manager.ts` 中的缓冲容量常量后重新构建。

---

## 14. exe 打包失败

**现象**：`bun run build:exe` 报错，或产物体积异常、运行时找不到静态资源。

**排查**

| 现象 | 原因与处理 |
| --- | --- |
| `此脚本必须在 Bun 下运行` | 用 `bun run build:exe`，不要用 `node` 执行 |
| `入口文件不存在` | 当前工作目录不对，请在项目根目录执行 |
| `静态资源目录不完整（缺少 index.html）` | `public/index.html` 缺失 |
| `提示：当前主机不是 Windows，已跳过 exe 图标与版本信息写入` | 正常提示。Windows 元数据依赖 Windows API，跨平台交叉编译时无法写入 |
| 生成的 exe 启动后页面 404 | 打包时未内嵌 `public/`。确认脚本里的 `compile.assets` 包含 `public`，且构建日志无报错 |

打包完成后可自检：

```bash
dist\scoop-manager.exe --no-open --port 3000
# 然后访问 http://127.0.0.1:3000/api/health，确认 static.source 为 embedded
```

---

## 15. pm2 相关

**现象**：`pm2 start ecosystem.config.cjs` 后进程反复重启。

**排查**

1. 看日志：`bun run pm2:logs`（或 `pm2 logs scoop-manager`）。
2. Node 版本低于 18 会直接启动失败 —— `node -v` 确认。
3. 使用 `scoop-manager-bun` 定义时，确保 `bun` 在 `PATH` 中且 `pm2` 能找到它。
4. 端口被占用：改 `ecosystem.config.cjs` 里的 `PORT`，或用环境变量 `SCOOP_MANAGER_PORT` 覆盖。

**注意**：pm2 配置里固定带 `--no-open`，避免每次重启都弹出浏览器；需要自动打开时删掉对应 app 的 `--no-open` 参数。

---

## 16. 数据目录与清理

数据目录默认为 `%USERPROFILE%\.scoop-manager`，包含：

| 文件 | 说明 |
| --- | --- |
| `config.json` | 应用自身配置（端口、监听地址、自定义 Scoop 路径等） |
| `jobs.json` | 任务历史 |
| `Scoopfile.json` | 最近一次导出的 Scoopfile |
| `import-Scoopfile-*.json` | 导入用的临时文件（每次导入一个唯一名字，任务结束后自动删除；若进程被强杀可能残留，可安全删除） |

**想重置一切**：停止程序，删除该目录即可（不会影响 Scoop 本身）。**想换位置**：设置环境变量 `SCOOP_MANAGER_HOME` 后重启。

---

## 17. 快速自检清单

出现问题时按顺序核对，通常能定位到具体环节：

1. `http://127.0.0.1:<端口>/api/health` —— 服务是否正常、`static.source` 为何
2. `supported` 是否为 `true`、`platform` 是否为 `win32`
3. `scoop.installed` 是否为 `true`、`scoop.powershell` 是否为 `null`
4. `/api/scoop/env` 的 `issues` 数组
5. `/api/search/index` 的 `entries` 是否大于 0
6. 概览页是否提示「不可写」→ 用管理员权限重启
7. 用 `--log-level debug` 重启，查看命令组装与 HTTP 访问日志

---

## 18. 反向代理 / 子路径部署问题

### 页面空白、样式丢失、接口 404

**原因**：前端资源与接口地址都基于「部署前缀」。程序需要知道对外前缀，才能拼出正确地址。

**处理**（二选一）

1. **代理剥离了前缀**（`proxy_pass http://127.0.0.1:3000/;`）→ 让代理把前缀通过请求头告诉程序：

   ```nginx
   proxy_set_header X-Forwarded-Prefix /scoop;
   ```

2. **代理透传前缀**（`proxy_pass http://127.0.0.1:3000;`）→ 启动时显式指定：

   ```bash
   scoop-manager.exe --base-path /scoop
   ```

**如何确认**：打开 `http://<对外地址>/scoop/api/health`，看 `basePath` 是否等于 `/scoop`；
再查看页面源码里 `<body data-base="…">` 的值。两者都为空说明前缀没传进来。

### 访问 `/scoop`（无尾斜杠）时资源 404

程序在配置了 `--base-path` 时会自动把 `/scoop` 308 跳到 `/scoop/`。
若代理层阻止了重定向，请在代理里补一条：

```nginx
location = /scoop { return 301 /scoop/; }
```

### 实时日志不动、任务结束后才一次性出现

**原因**：代理默认会缓冲响应体，SSE 被攒到最后才下发。

**处理**：nginx 加 `proxy_buffering off;` 并把 `proxy_read_timeout` 调大（例如 `3600s`）；
Caddy 的 `reverse_proxy` 默认不缓冲，通常无需额外配置。

### 代理后端口 / 地址显示不对

界面顶栏显示的是程序**自身监听**的地址（如 `127.0.0.1:3000`），不是对外地址，这是预期行为。
对外地址取决于你的代理配置。若需要，可在代理层设置 `X-Forwarded-Proto` 等标准头。

### 安全提醒

反向代理**不会**带来鉴权。本工具没有任何认证机制，暴露到公网前必须在代理层加访问控制
（`auth_basic`、IP 白名单、SSO 等），并优先保持 `--host 127.0.0.1` 只监听本机。

---

## 19. 桌面应用（Tauri 客户端）

### 启动时弹窗「未找到内置的本地服务程序」

说明 `desktop/binaries/scoop-manager-<三元组>.exe` 不存在。执行：

```bash
bun run desktop:prep
```

它会依次完成：编译 exe → 同步为 sidecar 命名 → 生成 `desktop/ui/` → 生成图标。

### 页面一直停在「正在连接本地服务…」或提示「无法连接到本地服务」

按顺序排查：

1. 打开 `%USERPROFILE%\.scoop-manager-desktop\desktop.log`，看有没有 sidecar 的输出。**桌面版没有控制台，所有日志都在这里。**
2. 若日志为空，说明 sidecar 根本没起来 —— 检查杀毒软件是否拦截了 `scoop-manager.exe`。
3. 若日志里有 `SyntaxError: import.meta is only valid inside modules`，说明 exe 是用旧的 `bytecode: true` 打包的，重新执行 `bun run desktop:prep`（该问题已在 `scripts/build-exe.ts` 修复）。
4. 托盘菜单选「重启服务」，再点界面上的「重试」。

### 托盘图标不见了

Windows 会把不常用的托盘图标折叠进「隐藏的图标」区域，展开即可看到。也可以在「任务栏设置 → 其他系统托盘图标」里把它固定显示。

### 点了窗口的 X，程序好像没退出

这是预期行为：关闭窗口 = 最小化到托盘，后端继续运行（否则正在跑的 `scoop install` 会被中断）。要真正退出，请用托盘菜单的「退出」。

### 任务历史在网页版和桌面版之间不互通

两者使用不同的数据目录（`.scoop-manager` 与 `.scoop-manager-desktop`），这是刻意设计，避免共享 `jobs.json` 时互相覆盖。如果需要统一，可以用环境变量把桌面端指向同一个目录：

```powershell
$env:SCOOP_MANAGER_HOME_DESKTOP = "$env:USERPROFILE\.scoop-manager"
```

（但两边同时运行时仍可能争抢写入，建议二选一。）

### `tauri dev` 报 `panicked at ... interface/rust.rs ... Option::unwrap() on a None value`

这是 **Rust 工具链安装不完整**的表现，与项目代码无关，可以先按下面确认。

Tauri CLI 启动时会执行 `rustc -vV`，从输出里找 `host:` 行来确定目标三元组：

```rust
stdout.split('\n').find(|l| l.starts_with("host:")).unwrap()
```

工具链损坏时 `rustc` 直接报错退出、stdout 为空，这个 `unwrap()` 就会 panic。注意 STDERR 里只会看到一行 panic，看不到 rustc 的真实报错，很容易误判成项目问题。

确认：

```powershell
rustc -vV
```

若输出下面这句，即命中本问题：

```
error: missing manifest in toolchain 'stable-x86_64-pc-windows-msvc'
help: this may happen if the toolchain installation was interrupted
```

修复（安装被中断会导致工具链目录存在但内容不全，`rustup toolchain list` 仍会把它列为 active，具有迷惑性）：

```powershell
rustup toolchain uninstall stable-x86_64-pc-windows-msvc
rustup toolchain install stable-x86_64-pc-windows-msvc
rustc -vV      # 必须能看到 host: x86_64-pc-windows-msvc
```

### `bun run desktop:build` 失败：找不到 cargo / rustc

Tauri 的外壳是 Rust 写的，需要先安装工具链：

```powershell
winget install Rustlang.Rustup
rustup default stable-msvc
```

安装后需要重开终端。首次构建会下载并编译依赖，约需 3～5 分钟。

> 若 `tauri info` 显示 `rustc: not installed` 但你确认已装过，先按上一条检查工具链是否完整。

### 安装包运行时报「缺少 WebView2」

`tauri.conf.json` 里配置的是 `downloadBootstrapper`，缺失时会联网下载安装。内网环境可改为离线安装包：

```json
"webviewInstallMode": { "type": "offlineInstaller", "silent": true }
```

### Rust 构建很慢 / 一行代码没改也要好几分钟

分两类，只有第一类是正常的：

**正常**：首次构建要从零编译 400+ 个 crate，release 通常 8～15 分钟，`tauri dev`（debug）快得多。

**不正常（可修复）**：什么都没改却每次都要重编译。历史上这里踩过两个坑，都已修掉：

1. **`desktop:prep` 无条件重写文件**。`tauri-build` 跟踪 `icons/`、`tauri::generate_context!()` 跟踪 `desktop/ui/` 的每个文件；全量重建会刷新所有 mtime，cargo 便判定 crate 失效，连带重做一次链接。
   现已改为**逐文件内容比对**：内容没变就不写盘，mtime 保持稳定。验证方式是连续跑两次 `bun run desktop:prep`，第二次应当输出「内容未变，跳过写入」且时间戳不变。

2. **`lto = true`（fat LTO）+ `codegen-units = 1`**。fat LTO 每次都要对整棵依赖树重算，且无法增量缓存，是 release 耗时的主要来源。已改为 `lto = "thin"`：快一个数量级，体积只差约 5%——而安装包 90% 的体积来自 86 MB 的 sidecar，外壳才 4 MB，这点体积差异没有意义。

排查命令：

```powershell
# 看 cargo 到底重编了什么（秒级）
cargo check --manifest-path desktop\Cargo.toml

# 只想清掉自己的包、保留依赖（换 profile 后想强制重编时用）
cargo clean --manifest-path desktop\Cargo.toml -p scoop-manager-desktop
```

日常迭代建议：改前端用 `bun run desktop:prep` 后直接在运行中的窗口按 `F5`；改 Rust 用 `cargo check` 快速验证语法，只在需要看效果时才 `bun run desktop:dev`。

> 注意：修改 `Cargo.toml` 的 `[profile.release]` 会让 release 缓存整体失效一次，下一次构建必定是全量的，属于预期。

### 界面报 `Failed to construct 'EventTarget': Please use the 'new' operator`

垫片 `desktop/shim/ipc-shim.js` 的历史 bug，仓库内已修复；如果还看到，说明运行的是旧构建。

原因是 `IpcEventSource` 早期用 ES5 风格继承原生 `EventTarget`：

```js
function IpcEventSource(url) {
  EventTarget.call(this);   // 原生 DOM 构造函数不能当普通函数调用
}
```

原生 DOM 构造函数只支持 `new` / `super()`，不能被 `[[Call]]`，所以必然抛错。现已改为：

```js
class IpcEventSource extends EventTarget {
  constructor(url) { super(); ... }
}
```

重新构建即可（垫片通过 `include_str!` 编进 Rust 二进制，改动会触发重编译）：

```powershell
bun run desktop:dev        # 或 bun run desktop:release
```

这类问题有回归测试兜底，改完垫片建议先跑一次：

```powershell
bun run test:shim
```

### 图标是占位的

`desktop/icons/` 下的图标由 `scripts/make-icon.ts` 生成，是刻意留的占位。拿到正式设计稿后直接覆盖这四个文件即可（`icon.ico`、`32x32.png`、`128x128.png`、`128x128@2x.png`），无需改代码。

### GitHub Actions 打包失败

**`bun install --frozen-lockfile` 报锁文件不同步**

`bun.lock` 与 `package.json` 不一致。本地跑一次 `bun install`，把新的 `bun.lock` 提交上去。

包管理器已统一为 bun：`pnpm-lock.yaml` 加入了 `.gitignore` 不再入库，避免两个锁文件并存时
Tauri CLI 报 `Only one package manager should be used`。

**`cargo check` 或 `tauri build` 报找不到 frontendDist / 图标**

`tauri-build` 要读 `bundle.icon`，`generate_context!` 要内嵌 `frontendDist`，而这两者都是
生成物（`desktop/ui/`、`desktop/icons/`），必须先跑 `bun run desktop:prep`。工作流里已含
这一步；本地直接调 `cargo` 时也别忘了。

**首次运行特别慢甚至超时**

Rust 依赖（400+ crate）在缓存未命中时要完整编译一次，release 通常 8～15 分钟。工作流用
`Swatinem/rust-cache` 缓存 `desktop/target`，命中后增量构建只需几十秒；`timeout-minutes`
设为 60，正常不会触发。

**Release 里只有安装包、缺少单文件 exe**

`dist/scoop-manager.exe` 没生成，或收集步骤没跑到。工作流会显式校验两个产物都存在，
缺任何一个都会直接失败并指出缺失项。

**安装包装完提示「未找到内置的本地服务程序」**

说明 `externalBin` 没打进包。工作流的「校验产物」步骤会用 7z 列出安装包内容并断言
`scoop-manager-desktop.exe` 与 `scoop-manager.exe` 都在包内；若这一步通过仍出问题，就是
运行期路径解析的故障，查 `%USERPROFILE%\.scoop-manager-desktop\desktop.log`。

### 如何确认桌面版真的没占端口

应用运行时，用任务管理器找到 `Scoop Manager`，记下 PID，然后：

```powershell
netstat -ano | findstr <PID>
```

应当**没有任何输出**。界面上顶栏的胶囊也会显示「桌面模式 · 无端口」，`GET /api/health` 的 `transport` 字段为 `ipc`。

---

## 20. 界面数据与磁盘不一致（在终端里操作过 Scoop）

**现象**：你在 PowerShell 里直接跑了 `scoop install` / `uninstall` / `update` / `hold` / `bucket add`，回到界面发现对不上：已安装列表多了或少了一条、锁定状态不变、bucket 清单数是旧的、可更新列表还是老样子。

**原因**：本程序用「目录快照 + 少量时间 TTL」避免重复扫盘，外部命令不会通知它。各类缓存的自动发现能力并不一致：

| 外部操作 | 能否自动发现 | 说明 |
| --- | --- | --- |
| `scoop install` / `uninstall` / `update` | ✅ 几秒内 | `apps` 目录快照一变就重扫（每次请求时校一次，代价是一次 `readdir`） |
| `scoop bucket add` / `rm` / `git pull` | ✅ 几秒内 | `buckets` 目录快照一变就重建索引 |
| `scoop config ...` | ✅ 立即 | 配置文件每次读取，没有缓存 |
| `scoop cache rm` | ✅ 立即 | 缓存体积每次进概览页实时统计 |
| `scoop hold` / `unhold` | ❌ | 只修改 `apps\<name>\current\install.json` 的**内容**，父目录 mtime 不变，目录快照捕捉不到 |
| 可更新列表（`scoop status` 结果） | ❌ | 有 5 分钟 TTL，必须显式作废 |

**处理**

1. 概览页点「**重新同步**」：一次性作废全部进程内缓存、重新读磁盘，并在后台重跑 `scoop status`；
   界面会在最多 30 秒内自动等待联网权威结果回填（期间按钮显示「同步中…」）。
2. 只想处理某一处时，用对应的单点入口：

   | 想刷新什么 | 在哪儿点 |
   | --- | --- |
   | 已安装列表 / 锁定状态 | 已安装页「重新扫描」 |
   | 可更新列表（联网） | 已安装页「检查更新状态」 |
   | 搜索索引 | 搜索页「重建索引」 |
   | 环境 / 版本 / PowerShell | 概览页「重新检测」 |
   | bucket 清单 | Bucket 管理页「更新全部」 |

3. 「可用更新」标题旁的徽标会显示当前数据来源：

   - **联网权威** = 来自 `scoop status`
   - **本地索引** = 只跟本地 bucket 比对过，bucket 未更新时可能滞后

> 也可以重启本程序 —— 效果等同于「重新同步」，但没必要。

---

## 21. 界面上的已安装清单和 `scoop list` 对不上

**现象**：界面显示 42 个应用，PowerShell 里 `scoop list` 只有 38 个（或反过来）。

先排除下面两个**已知差异**，多数时候不是 bug：

1. **界面合并了「用户」与「全局」两个目录，而 `scoop list` 默认只列用户目录**。
   界面上带「全局」标签的应用不会出现在 `scoop list` 的输出里，数量差通常正好等于全局应用数。
2. **残缺目录**：`apps\<name>` 存在但读不到 `current\install.json`（下载或解压中断留下的）时，
   界面会把它列出来并打上「**安装异常**」标记（对应 `scoop status` 的 `Install failed`），
   `scoop list` 不会列出它 —— 处理方式见第 22 节。

**排查步骤**

1. 已安装页点「**原始清单**」执行 `scoop list`，把两边的差异摆在一起看；
2. 用「**只看异常**」一键筛出有状态问题的应用（安装异常 / 清单缺失 / 缺依赖）；
3. 点「重新扫描」强制重读磁盘（绕过目录快照）；
4. 仍不一致时点概览页「重新同步」，把全部进程内缓存作废后重来；
5. 若界面多出来的是残缺目录，按第 22 节的步骤清理后重装即可。

> 界面数据走文件系统扫描、`scoop list` 只做对照展示，这个取舍见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 22. `scoop status` 里的 Install failed / Missing Dependencies

命令行里 `scoop status` 会多出这两列内容，界面把它们做成了应用名旁的标记
（「安装异常」「缺依赖 N」）与详情抽屉里的修复命令。两者性质完全不同：

### Install failed —— 安装残骸（`scoop uninstall` 对它无效）

**判定**（Scoop 的 `lib/core.ps1`）：

```powershell
function failed($app, $global) {
    $hasCurrent = (get_config NO_JUNCTION) -or (Test-Path "$appPath\current")
    return (Test-Path $appPath) -and !($hasCurrent -and (installed $app $global))
}
```

即 `apps\<name>` 目录还在，但 `current` 链接或 `install.json` 已经不成对 ——
上次安装 / 更新中断留下的残骸。**它不会有版本号，也不参与更新比对。**

**为什么 `scoop uninstall` 处理不了它**：Scoop 的卸载以 `install.json` 判断"是否安装"，
残骸读不出 `install.json`，于是它只打印 `ERROR '<name>' isn't installed.`、什么都不做。
更坑的是 Scoop 的 `error()` **只打印不退出**（`abort()` 才会设退出码），
所以这条命令的**退出码是 0** —— 在只看退出码的工具里会显示成"卸载成功"。

**处理**：对该应用点「卸载」——按钮会自动变成「**清理残骸**」（位置不变，只换文案与行为；
列表行的垃圾桶图标按钮同理，悬停提示会说明原因）。确认后它按 Scoop 卸载时相同的
方式清理：应用目录、该应用留下的 shim、persist 用户数据（与 `scoop uninstall --purge`
一致），任务日志逐条列出删了什么。

批量卸载会自动**跳过**残骸（`scoop uninstall` 对它们无效）并提示逐个清理——
用「只看异常」可以一键筛出来。

这条路径**只对残骸生效**：正常应用会被拒绝并要求走「卸载」，避免绕过 Scoop。
需要重新安装时再 `scoop install <app>` 即可。

> 手工等价操作：删除 `<SCOOP>\apps\<name>`、
> `<SCOOP>\shims\<name>.{shim,exe,cmd,ps1}`、`<SCOOP>\persist\<name>`。

> **`scoop` 自身不在判定范围内**：它是 git 克隆安装的（只有 `bin/scoop.ps1`，
> 没有 `install.json` / `manifest.json`），形式上和残骸一样。
> `scoop status` 自己也是排除它的（`scoop-status.ps1` 里的 `Where-Object name -NE 'scoop'`），
> 本程序的扫描同样排除，并且清理残骸接口对 `scoop` 有硬保险 —— 直接拒绝。

### Missing Dependencies —— 缺依赖

判定依据是清单里的 `depends`，且**按「已安装的 Scoop 应用名」比对，不看命令是否存在**：
系统里已经有 Windows 11 自带的 `C:\WINDOWS\system32\sudo.exe`，`scoop status` 照样报 `sudo` 缺失。

三种处理：

| 方案 | 说明 |
| --- | --- |
| **忽略** | 只影响状态显示。例如 fastgithub 只是在改 hosts 时需要提权，工具本身照常运行 |
| **装上依赖** | `scoop install sudo`。注意 `sudo` 清单来自 psutils（2020 年、每次调用弹 UAC）；本机 PATH 里 `system32` 早于 scoop 的 `shims`，不会顶掉系统原生 sudo |
| **改清单** | 不推荐：第三方 bucket 的清单会被 `scoop update` 还原 |

装 `gsudo` 之类**不能**消除警告 —— Scoop 认的是名字。

> 依赖为空的常见误解：依赖可能是在应用**安装之后**才加进 bucket 清单的
> （fastgithub 就是这样），所以界面读的是**当前** bucket 清单，
> 而不是 `apps\<app>\current\manifest.json` 那份安装快照。

---

## 23. 更新时满屏红字：未能加载指定的模块 `...\buckets\<名字>\scripts\...`

**现象**：更新某个应用时日志里出现这样的连锁报错，但应用最后仍然装成功了：

```
Import-Module : 未能加载指定的模块"G:\scoop\buckets\dorado\scripts\DoradoUtils.psm1"，因为在任何模块目录中都没有找到有效模块文件。
Mount-ExternalRuntimeData : 无法将"Mount-ExternalRuntimeData"项识别为 cmdlet、函数、脚本文件或可运行程序的名称。
Remove-Module : 没有删除任何模块。请确认要删除的模块的规范正确，并且运行空间中存在这些模块。
```

**先排除最常见的一种误判：这不是权限问题**，也**不要**改用管理员身份重试。

- `Import-Module` 的失败类别是 `ResourceUnavailable` / 文件找不到（`FileNotFoundException`）；
  权限问题会显示「拒绝访问」或 `UnauthorizedAccessException`。
- 管理员身份运行普通的 `scoop update` 反而有副作用（文件属主、安装范围），只有 `-g` 全局安装才需要提权。

**原因**：该应用的清单脚本硬编码了**另一个 bucket** 的辅助模块，例如：

```powershell
Import-Module $(Join-Path $(Find-BucketDirectory -Root -Name dorado) scripts/DoradoUtils.psm1)
Mount-ExternalRuntimeData -Source "$persist_dir\UserData" -Target "$env:APPDATA\bilibili"
```

它要求本地存在一个**名为 `dorado`** 的 bucket。若你装的是它的镜像（例如把 `kkzzhizhou/scoop-apps`
的内容并进了 `third`），模块文件其实躺在 `buckets\third\scripts\` 下，而脚本按 bucket 名去
`buckets\dorado\scripts\` 找 —— 找不到，于是紧随其后的 `Mount-ExternalRuntimeData` 也不存在
（它正是该模块里定义的函数），再往下的 `Remove-Module` 同样报错。**三条报错是同一个原因**，不是三个问题。

**影响**：脚本的其余步骤照常执行，应用多半仍然安装成功；唯一被跳过的是「把用户数据目录挂到 scoop 的
`persist` 目录」这一步。数据仍在 `%APPDATA%\<应用>` 里，**不会丢**，只是不随 scoop 迁移/清理
（也意味着用「卸载（彻底清理）」删的是 `persist`，不会误删这些数据）。

**处理**：

1. 任务页此时会在日志下方给出**建议块**，点「添加 Bucket」直接跳到 Bucket 页（名称已预填），
   填上仓库地址即可添加；
2. 命令行等价操作：`scoop bucket add dorado <仓库地址>`（地址在日志里看不出来，需要你确认来源）；
3. 加好后重新执行一次同样的更新即可补齐这一步；不在意 persist 挂载的话也可以直接忽略。

> 判定条件与文案见 `src/jobs/hints.ts`，回归用例见 `scripts/hints-selftest.ts`（含正常输出零误报的护栏）。

