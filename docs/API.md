# API 文档

所有接口均以 `/api` 为前缀，请求与响应体为 JSON（`Content-Type: application/json`）。

> **部署子路径时**：下文所有路径都相对于部署前缀。例如 `--base-path /scoop` 时，
> `GET /api/health` 的实际地址是 `/scoop/api/health`（不带前缀的地址同样可用，向后兼容）。
> 前端不需要知道前缀 —— 服务端会把它注入到 index.html 的 `<body data-base="…">` 中。

## 一、通用约定

### 成功响应

```json
{ "ok": true, "data": { } }
```

### 失败响应

```json
{
  "ok": false,
  "error": {
    "code": "SCOOP_NOT_INSTALLED",
    "message": "未检测到可用的 Scoop 安装，请先安装或指定已有路径。",
    "detail": { "issues": ["..."] }
  }
}
```

`message` 一律为可直接展示的**中文**文案；`detail` 为可选的结构化补充信息（例如原始 stderr、校验失败详情）。

### HTTP 状态码

| 状态码 | 含义 |
| --- | --- |
| `200` | 查询成功 |
| `202` | 已创建任务（异步执行），响应体包含 `job` 摘要 |
| `400` | 参数非法（`INVALID_PARAM`、`JOB_NOT_CANCELABLE`） |
| `404` | 资源不存在（`NOT_FOUND`、`JOB_NOT_FOUND`、`SCOOP_NOT_FOUND`） |
| `409` | 环境不满足（`PLATFORM_UNSUPPORTED`、`SCOOP_NOT_INSTALLED`、`POWERSHELL_NOT_FOUND`） |
| `422` | 命令执行失败 / 超时 / 被取消（`COMMAND_FAILED`、`TIMEOUT`、`CANCELED`） |
| `500` | 服务内部错误（`INTERNAL`） |

### 错误码表

| code | 说明 |
| --- | --- |
| `PLATFORM_UNSUPPORTED` | 当前不是 Windows，Scoop 功能不可用 |
| `SCOOP_NOT_FOUND` | 指定的 Scoop 路径不存在或不是合法安装 |
| `SCOOP_NOT_INSTALLED` | 未检测到可用 Scoop（未安装或未接入） |
| `POWERSHELL_NOT_FOUND` | 未找到 PowerShell，无法执行命令 |
| `INVALID_PARAM` | 请求参数不合法（含名称、路径、代理格式校验失败） |
| `NOT_FOUND` | 路径 / 资源不存在 |
| `JOB_NOT_FOUND` | 任务不存在或已被清理 |
| `JOB_NOT_CANCELABLE` | 任务已处于终态，无法取消 |
| `COMMAND_FAILED` | scoop 命令返回非 0 退出码 |
| `TIMEOUT` | 命令执行超时 |
| `CANCELED` | 命令被用户取消 |
| `INTERNAL` | 未预期的服务内部错误 |

### 输入校验规则

| 字段类型 | 规则 |
| --- | --- |
| 应用名 / Bucket 名 / 缓存条目名 | `^[A-Za-z0-9][A-Za-z0-9._+-]*$` |
| 配置键名 | `^[A-Za-z][A-Za-z0-9._-]*$` |
| 路径 | 必须为绝对路径，且（在使用处）存在 |
| 代理地址 | `host:port`、`http(s)://host:port`、`http://user:pass@host:port`，或关键字 `current` / `none` |
| 架构 | `64bit` / `32bit` / `arm64` |
| 布尔 | 接受 `true` / `false` / `1` / `0` / `"true"` / `"false"` |

---

## 二、基础与概览

### GET `/api/health`

健康检查与运行时元信息，同时是排障入口。

```json
{
  "ok": true,
  "data": {
    "name": "scoop-manager",
    "description": "Scoop 的 Web GUI 管理器",
    "version": "1.0.0",
    "runtime": "Bun 1.2.0",
    "kind": "bun",
    "standalone": false,
    "platform": "win32",
    "supported": true,
    "dataDir": "C:\\Users\\me\\.scoop-manager",
    "uptimeSeconds": 128,
    "transport": "http",
    "server": { "host": "127.0.0.1", "port": 3000, "portShifted": false },
    "basePath": "",
    "static": { "dir": "G:\\...\\public", "source": "disk", "candidates": ["..."] },
    "jobs": { "running": 1, "queued": 0 },
    "scoop": { "installed": true, "root": "C:\\Users\\me\\scoop", "version": "2024.10.1", "powershell": "pwsh" }
  }
}
```

`static.source` 取值：`disk`（磁盘） / `embedded`（exe 内嵌） / `none`（未找到，界面无法加载）。

`transport` 取值：

| 值 | 含义 | `server` 字段 |
| --- | --- | --- |
| `http` | 服务模式，监听 TCP 端口 | `host` / `port` 有效 |
| `ipc` | 桌面应用模式，经 stdin/stdout 通信 | `port` 恒为 `0`（未监听任何端口） |

### GET `/api/overview`

首屏引导数据：环境 + 计数 + 可更新列表 + 代理摘要，前端一次请求拿齐。

```json
{
  "ok": true,
  "data": {
    "appVersion": "1.0.0",
    "scoop": { "...": "ScoopEnvironment，见下" },
    "counts": {
      "installed": 42,
      "global": 3,
      "held": 1,
      "buckets": 4,
      "updatable": 6,
      "cacheBytes": 1288490188,
      "indexEntries": 5821
    },
    "updates": [
      { "name": "nodejs", "installed": "20.11.0", "available": "22.2.0", "bucket": "main", "global": false, "hold": false }
    ],
    "updatesNote": "结果基于本地 bucket 数据，若长时间未更新 bucket，可能滞后于实际最新版本。",
    "proxy": { "value": "127.0.0.1:7890", "mode": "custom", "display": "127.0.0.1:7890" },
    "configFile": "C:\\Users\\me\\scoop\\apps\\scoop\\current\\apps\\scoop\\config.json",
    "jobs": { "running": 0, "recent": [] }
  }
}
```

`updates` 最多返回 50 条。

### ScoopEnvironment 结构

下列接口的 `data` 或 `data.scoop` 均为此结构：

`GET /api/scoop/env`、`POST /api/scoop/env/refresh`、`PUT /api/scoop/path`、`DELETE /api/scoop/path`。

```json
{
  "platform": "win32",
  "supported": true,
  "installed": true,
  "root": "C:\\Users\\me\\scoop",
  "rootSource": "env",
  "globalRoot": "C:\\ProgramData\\scoop",
  "shimsPath": "C:\\Users\\me\\scoop\\shims",
  "appsPath": "C:\\Users\\me\\scoop\\apps",
  "globalAppsPath": "C:\\ProgramData\\scoop\\apps",
  "scriptPath": "C:\\Users\\me\\scoop\\apps\\scoop\\current\\bin\\scoop.ps1",
  "version": "2024.10.1",
  "channel": "master",
  "configFile": "C:\\Users\\me\\scoop\\apps\\scoop\\current\\apps\\scoop\\config.json",
  "powershell": { "path": "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "kind": "pwsh", "executionPolicy": "RemoteSigned" },
  "issues": [],
  "checkedAt": 1730000000000
}
```

`rootSource`：`app-config` / `env` / `config-file` / `default` / `path` / `null`。
`channel`：`master`（git 克隆安装）/ `versioned`（版本化安装）/ `null`。

### POST `/api/scoop/env/refresh`

清除环境缓存、已安装应用缓存与 manifest 索引后重新探测，随后可用 `GET /api/scoop/env` 取最新结果。

```json
{ "ok": true, "data": { "...": "ScoopEnvironment" } }
```

---

## 三、Scoop 安装与定位

### POST `/api/scoop/install`

调用官方脚本安装 Scoop。**返回 202 与任务摘要**，通过 SSE 观察进度。

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `targetDir` | string \| null | 否 | 安装目录（绝对路径）；留空使用默认 `%USERPROFILE%\scoop` |
| `runAsAdmin` | boolean | 否 | 是否以管理员身份安装（触发 UAC） |
| `proxy` | string \| null | 否 | 安装过程使用的代理；留空时自动沿用本程序保存的代理（见下文「配置与代理」） |

代理注入方式（进程级，不改动系统设置与 git 全局配置）：

- `HTTP_PROXY` / `HTTPS_PROXY`（含小写）注入子进程环境 —— 覆盖 git 克隆 bucket、aria2 下载
- PowerShell 会话内设置 `[System.Net.WebRequest]::DefaultWebProxy` —— 覆盖 Windows PowerShell 5.1 的
  `Invoke-RestMethod`（它不读环境变量），用于下载 get.scoop.sh 安装脚本
- 安装成功后，若代理为自定义地址会自动执行 `scoop config proxy <值>` 同步给后续 Scoop 命令

```json
{ "ok": true, "data": { "job": { "id": "j_xxx", "kind": "scoop.install", "status": "running", "...": "..." } } }
```

任务结束后自动失效环境 / 应用 / 索引缓存。

### PUT `/api/scoop/path`

接入已存在的 Scoop 安装。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `dir` | string | 是 | Scoop **根目录**绝对路径 |

```
PUT /api/scoop/path
{ "dir": "D:\\scoop" }
```

校验失败（目录不存在、缺少 `apps` 或 `scoop.ps1`）返回 `SCOOP_NOT_FOUND`。成功返回新的 `ScoopEnvironment`。

### DELETE `/api/scoop/path`

清除应用配置中手写的 Scoop 路径，回退到自动探测。返回新的 `ScoopEnvironment`。

### POST `/api/scoop/checkup`

执行 `scoop checkup`。返回 202 与任务。

### POST `/api/scoop/self-update`

执行 `scoop update`（更新 Scoop 自身与 bucket）。返回 202。任务结束后失效环境、索引与应用缓存。

### GET `/api/scoop/export`

执行 `scoop export` 导出 Scoopfile。

| Query | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `config` | boolean | `false` | 为 `true` 时附加 `-c`，导出中包含配置 |

```json
{
  "ok": true,
  "data": {
    "json": "[{\"Name\":\"7zip\",\"Source\":\"main\"}]",
    "file": "C:\\Users\\me\\.scoop-manager\\Scoopfile.json",
    "appCount": 1
  }
}
```

同时会在数据目录落盘一份 `Scoopfile.json`。

### POST `/api/scoop/import`

导入 Scoopfile（JSON 数组）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | string | 二选一 | Scoopfile 的 JSON 文本 |
| `scoopfile` | array | 二选一 | 直接传数组（内部会序列化） |

返回 202 与任务，任务类型为 `scoop.import`。

---

## 四、缓存与清理

### GET `/api/cache`

```json
{
  "ok": true,
  "data": {
    "path": "C:\\Users\\me\\scoop\\cache",
    "totalBytes": 1288490188,
    "totalEntries": 37,
    "entries": [
      { "name": "nodejs#22.2.0", "size": 33554432, "type": "dir", "mtime": 1730000000000 }
    ],
    "truncated": false
  }
}
```

条目最多返回 300 条，超出时 `truncated` 为 `true`。Scoop 未安装时 `path` 为 `null`、计数为 0。

### POST `/api/cache/remove`

清理下载缓存。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `target` | string \| null | 否 | 指定缓存条目名；留空表示清空全部（`scoop cache rm *`） |

返回 202 与任务（`cache.remove`）。

### POST `/api/cache/cleanup`

清理旧版本。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `apps` | string[] | 否 | 指定应用；留空或 `["*"]` 表示全部（`scoop cleanup *`） |

返回 202 与任务（`app.cleanup`）。

---

## 五、已安装应用

### GET `/api/apps`

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "name": "7zip",
        "version": "24.08",
        "bucket": "main",
        "architecture": "64bit",
        "hold": false,
        "global": false,
        "path": "C:\\Users\\me\\scoop\\apps\\7zip\\current",
        "description": "A multi-format file archiver",
        "homepage": "https://7-zip.org/",
        "updatedAt": 1730000000000,
        "shims": ["7z", "7za"],
        "isScoop": false
      }
    ]
  }
}
```

结果缓存 3 秒；变更类任务（安装 / 卸载 / 更新 / 锁定 / 重置 / bucket 变更）结束后会主动失效。

### GET `/api/apps/updates`

基于「已安装版本 vs 本地 bucket manifest 版本」的比对结果。

```json
{
  "ok": true,
  "data": {
    "items": [{ "name": "nodejs", "installed": "20.11.0", "available": "22.2.0", "bucket": "main", "global": false, "hold": false }],
    "indexBuiltAt": 1730000000000,
    "indexEntries": 5821,
    "note": "结果基于本地 bucket 数据，若长时间未更新 bucket，可能滞后于实际最新版本。"
  }
}
```

### POST `/api/apps/status`

执行 `scoop status`（实时联网检查更新，较慢）。返回 202 与任务。

### GET `/api/apps/:name`

应用详情。

```json
{
  "ok": true,
  "data": {
    "installed": { "...": "InstalledApp，未安装时为 null" },
    "manifest": { "version": "24.08", "description": "..." },
    "available": [{ "name": "7zip", "version": "24.08", "bucket": "main", "...": "ManifestEntry" }]
  }
}
```

### POST `/api/apps/install`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `apps` | string[] | — | **必填**，应用名列表（`*` 会被过滤） |
| `global` | boolean | `false` | `-g` 全局安装（需管理员） |
| `independent` | boolean | `false` | `-i` 独立安装 |
| `skipHash` | boolean | `false` | `-s` 跳过哈希校验 |
| `noCache` | boolean | `false` | `-n` 不使用缓存 |
| `arch` | string | — | `-a 64bit` / `32bit` / `arm64` |

等价命令：`scoop install [-g] [-i] [-s] [-n] [-a <arch>] <apps...>`

返回 202 与任务（`app.install`）。

### POST `/api/apps/uninstall`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `apps` | string[] | — | **必填** |
| `global` | boolean | `false` | `-g` |
| `purge` | boolean | `false` | `-p` 彻底清理 |

返回 202 与任务（`app.uninstall`）。

### POST `/api/apps/update`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `all` | boolean | `false` | 为 `true` 时更新全部（忽略 `apps`） |
| `apps` | string[] | — | `all` 为 `false` 时必填 |
| `force` | boolean | `false` | `-f` 强制更新 |
| `global` | boolean | `false` | `-g` |

返回 202 与任务（`app.update`，超时上限 60 分钟）。

### POST `/api/apps/hold`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `apps` | string[] | — | **必填** |
| `hold` | boolean | `true` | `true` 执行 `hold`，`false` 执行 `unhold` |
| `global` | boolean | `false` | `-g` |

返回 202 与任务（`app.hold` / `app.unhold`）。

### POST `/api/apps/reset`

执行 `scoop reset <apps...>`，用于重建 shim 与链接。

| 字段 | 类型 | 必填 |
| --- | --- | --- |
| `apps` | string[] | 是 |

返回 202 与任务（`app.reset`）。

---

## 六、搜索与仓库详情

搜索完全基于本地 bucket manifest 内存索引，**不联网**，毫秒级返回。

### GET `/api/search`

| Query | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `q` | string | `""` | 关键词（匹配名称、描述、主页等） |
| `bucket` | string | — | 限定来源 Bucket |
| `limit` | number | `60` | 1–200 |
| `offset` | number | `0` | 分页偏移 |

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "name": "nodejs",
        "version": "22.2.0",
        "description": "Asynchronous event-driven JavaScript runtime",
        "homepage": "https://nodejs.org",
        "license": "MIT",
        "bucket": "main",
        "depends": [],
        "suggests": [],
        "bin": ["node.exe", "npm.cmd"],
        "updatedAt": 1730000000000
      }
    ],
    "total": 3,
    "took": 4,
    "indexReady": true,
    "index": { "entries": 5821, "buckets": ["main", "extras"], "builtAt": 1730000000000, "building": false, "took": 412 },
    "buckets": ["main", "extras"]
  }
}
```

### GET `/api/search/index`

返回索引统计（`IndexStats`），用于判断索引是否就绪。字段同上 `index`。

### POST `/api/search/index/refresh`

强制重建索引后返回新的统计信息。用于手动改动 bucket 目录后的刷新。

### GET `/api/search/app/:name`

单个应用的仓库条目与递归依赖解析。

```json
{
  "ok": true,
  "data": {
    "name": "nodejs",
    "found": true,
    "entries": [{ "...": "ManifestEntry" }],
    "dependencies": [
      { "name": "nvm", "version": "1.1.11", "bucket": "main", "installed": false, "missing": false }
    ],
    "installed": true
  }
}
```

`dependencies[].missing` 为 `true` 表示该依赖在本地清单中找不到（通常因为缺少对应 Bucket）；依赖解析做了环路保护，最大深度 5。应用不存在时返回 `found: false` 且数组为空（HTTP 仍为 200）。

---

## 七、Bucket 管理

### GET `/api/buckets`

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "name": "extras",
        "source": "https://github.com/ScoopInstaller/Extras",
        "manifestCount": 2143,
        "updatedAt": 1730000000000,
        "official": true,
        "path": "C:\\Users\\me\\scoop\\buckets\\extras"
      }
    ],
    "index": { "entries": 5821, "buckets": ["main", "extras"], "builtAt": 1730000000000, "building": false, "took": 412 }
  }
}
```

`source` 从 `.git/config` 解析；非 git 仓库为 `null`。

### GET `/api/buckets/known`

```json
{
  "ok": true,
  "data": {
    "items": [{ "name": "extras", "added": true, "official": true }],
    "source": "scoop"
  }
}
```

`source`：`scoop`（来自 `scoop bucket known`）/ `fallback`（内置兜底列表）。

### POST `/api/buckets`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | Bucket 名称（须符合名称校验规则） |
| `repoUrl` | string \| null | 否 | 仓库地址，须以 `https://`、`git@`、`ssh://`、`git://` 开头；留空使用 Scoop 内置映射 |

返回 202 与任务（`bucket.add`），任务结束后失效 manifest 索引。

### DELETE `/api/buckets/:name`

删除 Bucket（`scoop bucket rm <name>`）。返回 202 与任务（`bucket.remove`），结束后失效索引与应用缓存。

### POST `/api/buckets/update`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string \| null | 否 | 指定 Bucket；留空 / null 表示同步全部 |

返回 202 与任务（`bucket.update`，超时上限 20 分钟）。

> **实现说明**：Scoop 没有提供 `scoop bucket update` 子命令（实测 `scoop-bucket.ps1`
> 只支持 add / list / known / rm）。本操作与 Scoop 自身的 `Sync-Bucket` 一致：
> 对每个「是 git 仓库」的 bucket 执行 `git pull`，非 git 仓库的 bucket 会被跳过并在任务日志中提示；
> 同时会把「配置与代理」里设置的代理以 `-c http.proxy` / `-c https.proxy` 透传给 git
> （git 不读取 scoop 的代理设置）。指定 bucket 不存在返回 `NOT_FOUND`，
> 不是 git 仓库返回 `COMMAND_FAILED`。

---

## 八、配置与代理

### GET `/api/config`

```json
{
  "ok": true,
  "data": {
    "file": "C:\\Users\\me\\scoop\\apps\\scoop\\current\\apps\\scoop\\config.json",
    "exists": true,
    "writable": true,
    "entries": [
      { "key": "proxy", "value": "127.0.0.1:7890", "sensitive": true }
    ],
    "proxy": { "value": "127.0.0.1:7890", "mode": "custom", "display": "127.0.0.1:***" },
    "notes": ["当前配置文件不可写，修改配置可能失败（请检查文件权限）。"]
  }
}
```

- `exists`：配置文件是否已创建（未创建时首次设置任意配置项会自动生成）
- `writable`：是否可写
- `entries[].sensitive`：值为敏感信息（如含密码的代理），前端默认打码
- `proxy.mode`：`none` / `system` / `custom`

### GET `/api/config/keys`

返回常用配置项参考列表（非穷举）。

```json
{
  "ok": true,
  "data": {
    "items": [
      { "key": "aria2-enabled", "label": "启用 aria2 多线程下载", "description": "显著提升下载速度，需要先安装 aria2", "type": "boolean", "suggestion": "true" }
    ]
  }
}
```

### PUT `/api/config`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 是 | 配置键名 |
| `value` | string \| number \| boolean | 是 | 配置值 |

实际执行 `scoop config <key> <value>`。返回 202 与任务（`config.set`）。

### DELETE `/api/config/:key`

执行 `scoop config rm <key>`。返回 202 与任务（`config.remove`）。

### GET `/api/config/proxy`

返回**当前生效**的代理。Scoop 已安装时读 `scoop config`，未安装时读本程序自身配置
（存在「先有鸡还是先有蛋」的问题：`scoop config proxy` 在安装 Scoop 之前不可用，
而安装恰恰最需要代理）。

```json
{
  "ok": true,
  "data": {
    "value": "127.0.0.1:7890",
    "mode": "custom",
    "display": "127.0.0.1:7890",
    "source": "scoop",
    "scoopInstalled": true,
    "file": "C:\\...\\config.json"
  }
}
```

- `source`：`scoop`（来自 scoop config）/ `manager`（来自本程序配置）/ `none`
- `scoopInstalled`：为 `false` 时 `source` 只可能是 `manager` 或 `none`

### PUT `/api/config/proxy`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `value` | string | 是 | 代理地址或关键字 `current` / `none` |

**Scoop 已安装**：返回 202 与任务（`config.set`），即 `scoop config proxy`。
**Scoop 未安装**：返回 200 与 `{ "job": null, "proxy": {...} }`，值保存到本程序自身配置，
并在安装 Scoop 时自动注入（见 `/api/scoop/install`）。任务标题中的密码会被脱敏。

### DELETE `/api/config/proxy`

清除代理。已安装时执行 `scoop config rm proxy`（202 + 任务）；未安装时直接清掉本程序保存的值（200 + `job: null`）。

### POST `/api/config/proxy/test`

对代理地址做一次 TCP 握手探测（不发送业务数据）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `value` | string | 否 | 待测地址；留空时测试当前生效的代理 |

```json
{
  "ok": true,
  "data": {
    "ok": true,
    "ms": 23,
    "error": null,
    "target": "127.0.0.1:7890",
    "hint": "代理端口可连通。"
  }
}
```

失败示例（仍为 HTTP 200，业务结果在 `data.ok`）：

```json
{ "ok": true, "data": { "ok": false, "ms": 5001, "error": "连接超时", "target": "127.0.0.1:7890", "hint": "代理端口不可达，请确认代理软件已启动且端口正确。" } }
```

若当前为 `current`（跟随系统代理），会返回 `ok:false` 并说明无法直接测试。

---

## 九、任务与实时日志

参见 [ARCHITECTURE.md](./ARCHITECTURE.md#任务与-sse) 了解设计动机。

### GET `/api/jobs`

| Query | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `status` | string | — | 过滤状态：`queued` / `running` / `succeeded` / `failed` / `canceled` / `timeout` |
| `kind` | string | — | 过滤任务类型（如 `app.install`） |
| `limit` | number | `100` | 1–500 |

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "j_lx3k2a",
        "kind": "app.install",
        "title": "安装：7zip",
        "target": "7zip",
        "status": "running",
        "createdAt": 1730000000000,
        "startedAt": 1730000000100,
        "endedAt": null,
        "exitCode": null,
        "canCancel": true,
        "error": null,
        "seq": 128
      }
    ],
    "running": 1,
    "queued": 0
  }
}
```

### POST `/api/jobs/clear`

清理所有**已结束**的任务记录，返回被清理的数量。

```json
{ "ok": true, "data": { "removed": 12 } }
```

### GET `/api/jobs/:id`

任务详情，在摘要基础上追加日志与裁剪标记。

```json
{
  "ok": true,
  "data": {
    "id": "j_lx3k2a",
    "kind": "app.install",
    "title": "安装：7zip",
    "status": "succeeded",
    "exitCode": 0,
    "seq": 128,
    "truncated": false,
    "logs": [{ "seq": 1, "ts": 1730000000100, "stream": "stdout", "text": "Installing '7zip' (24.08)..." }]
  }
}
```

`stream`：`stdout` / `stderr` / `system`。任务不存在返回 `JOB_NOT_FOUND`（404）。

### POST `/api/jobs/:id/cancel`

取消任务：终止整个进程树（`taskkill /pid <pid> /T /F`）。

```json
{ "ok": true, "data": { "state": "canceling", "job": { "...": "JobSummary" } } }
```

- 任务已处于终态时返回 `JOB_NOT_CANCELABLE`（400）
- 任务不存在时返回 `JOB_NOT_FOUND`（404）
- `state` 为 `canceled` 表示任务当时仍在排队、已直接标记取消

### DELETE `/api/jobs/:id`

从历史中移除该任务记录。

```json
{ "ok": true, "data": { "removed": true } }
```

### GET `/api/jobs/:id/events`（SSE）

实时事件流，`Content-Type: text/event-stream`。

| 参数 | 位置 | 说明 |
| --- | --- | --- |
| `id` | path | 任务 ID |
| `since` | query | 从该序号之后开始推送，用于断线补偿 |
| `Last-Event-ID` | header | 与 `since` 等价，`since` 优先 |

**事件类型**

| event | 说明 | data |
| --- | --- | --- |
| `log` | 一行输出 | `JobEvent`（含 `stream` / `text`） |
| `status` | 状态变化（如 queued → running） | `JobEvent`（含 `status`） |
| `done` | 任务终态 | `JobEvent`（含 `status` / `exitCode` / `error`） |
| `notice` | 提示（如历史日志被裁剪） | `{ code, message }` |
| `ping` | 心跳（每 15 秒一次） | `{}` |
| `eof` | 流结束，客户端应关闭连接 | `{}` |

每条事件的 SSE `id` 字段即为 `seq`，单调递增。客户端重连时带上 `?since=<最后收到的 seq>` 即可从断点续传，**不丢日志**。

**JobEvent 结构**

```ts
interface JobEvent {
  seq: number;                    // 单调递增序号
  ts: number;                     // 毫秒时间戳
  type: 'log' | 'status' | 'done';
  stream?: 'stdout' | 'stderr' | 'system';  // type === 'log'
  text?: string;                  // type === 'log'
  status?: JobStatus;             // type === 'status' | 'done'
  exitCode?: number | null;       // type === 'done'
  error?: { code: string; message: string; detail?: unknown };  // type === 'done'
}
```

**任务类型（`kind`）**

`scoop.install`、`scoop.update`、`scoop.checkup`、`scoop.export`、`scoop.import`、`app.install`、`app.uninstall`、`app.update`、`app.hold`、`app.unhold`、`app.cleanup`、`app.reset`、`bucket.add`、`bucket.remove`、`bucket.update`、`config.set`、`config.remove`、`cache.remove`、`script.run`

任务已结束时，SSE 只重放历史事件随即发送 `eof`，不会保持长连接。

---

## 十、静态资源

| 路径 | 说明 |
| --- | --- |
| `GET /` | 返回 `index.html` |
| `GET /css/style.css` | 主题样式 |
| `GET /js/*` | 前端 ES Module |
| `GET /vendor/alpine.min.js` | 内置的 Alpine.js |

- 未命中且**带扩展名**的路径返回 404 JSON；**不带扩展名**的路径回退到 `index.html`。
- 响应头包含 `Content-Security-Policy`（禁止一切外部资源）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
- `vendor/` 下资源允许 7 天强缓存，其余为 `no-cache`。
- 兜底：`GET /api/*` 未匹配时返回 JSON 格式的 404，而不是落回 `index.html`。

