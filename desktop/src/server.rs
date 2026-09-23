//! sidecar 进程生命周期管理。
//!
//! 刻意不用 `tauri-plugin-shell`，而是直接用 `std::process::Command`：
//!   - 插件按行读取 stdout，而我们的协议是**二进制分帧**，body 里含换行，
//!     按行切会直接破坏帧边界；
//!   - 自己控制 `CREATE_NO_WINDOW`，避免控制台黑框一闪而过；
//!   - 少一个插件依赖，二进制更小。

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::bridge::{Bridge, FrameAccumulator};

/// 应用正在退出：此时 sidecar 退出属于预期行为，不要再提醒用户
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// 桌面端独立数据目录。
///
/// 刻意与服务模式（`%USERPROFILE%\.scoop-manager`）分开：两者共享 config.json
/// 与 jobs.json 会互相覆盖，隔离后可以同时运行、互不干扰。
pub fn data_dir() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("SCOOP_MANAGER_HOME_DESKTOP") {
        if !custom.is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(|home| PathBuf::from(home).join(".scoop-manager-desktop"))
}

fn log_file() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("desktop.log"))
}

/// 追加 sidecar 的 stderr 到 desktop.log。桌面端没有控制台，这是唯一的日志出口。
fn append_log(text: &str) {
    let Some(file) = log_file() else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut handle) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = handle.write_all(text.as_bytes());
    }
}

/// 定位 sidecar 可执行文件。
///
/// 打包态由 Tauri 放到主程序同级并剥掉目标三元组后缀；开发态在 `desktop/binaries/`
/// 下带着后缀。两种形态都要能找到。
fn sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("无法定位当前程序路径：{error}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "无法定位当前程序目录。".to_string())?
        .to_path_buf();
    let triple = env!("SCOOP_MANAGER_TARGET_TRIPLE");

    let candidates = [
        // 打包态
        dir.join("scoop-manager.exe"),
        dir.join("scoop-manager"),
        // 开发态：target/debug 或 target/release
        dir.join(format!("scoop-manager-{triple}.exe")),
        dir.join(format!("scoop-manager-{triple}")),
        // 开发态：desktop/binaries/
        dir.join("..")
            .join("..")
            .join("binaries")
            .join(format!("scoop-manager-{triple}.exe")),
        dir.join("..").join("..").join("binaries").join("scoop-manager.exe"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }

    let tried = candidates
        .iter()
        .map(|path| format!("  {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "未找到内置的本地服务程序 scoop-manager。\n请先执行 `bun run desktop:prep` 生成它。\n已尝试：\n{tried}"
    ))
}

// ---------------------------------------------------------------- 启动

pub fn spawn(app: &AppHandle) -> Result<(), String> {
    let binary = sidecar_path()?;
    let home = data_dir().ok_or_else(|| "无法定位应用数据目录。".to_string())?;
    std::fs::create_dir_all(&home).map_err(|error| format!("无法创建数据目录 {}：{error}", home.display()))?;

    let mut command = Command::new(&binary);
    command
        .arg("--rpc")
        .arg("stdio")
        .arg("--no-open")
        // CLI 覆盖不写回 config.json，避免污染用户为 pm2 / 反向代理准备的配置
        .arg("--no-persist")
        // 父进程被强杀时 sidecar 自行退出，避免孤儿进程
        .arg("--parent-pid")
        .arg(std::process::id().to_string())
        // 数据隔离：sidecar 的 config.json / jobs.json 落在桌面端专属目录
        .env("SCOOP_MANAGER_HOME", &home)
        .current_dir(&home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// CREATE_NO_WINDOW
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    eprintln!("[server] 启动本地服务：{}", binary.display());
    append_log(&format!("[boot] 启动本地服务：{}\n", binary.display()));

    let mut child = command
        .spawn()
        .map_err(|error| format!("本地服务启动失败（{}）：{error}", binary.display()))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let bridge = app.state::<Bridge>();
    // 先登记句柄再启动读取线程：读取线程一启动就可能收到 ready 帧。
    // 记下代次，让这条读取线程只对"它盯的那个进程"生效（见 mark_dead_if_current）。
    let generation = bridge.attach(child);

    // ---- stdout：按帧累积。注意不能按行读，body 里含换行。
    if let Some(stdout) = stdout {
        let handle = app.clone();
        std::thread::spawn(move || {
            let bridge = handle.state::<Bridge>();
            let mut accumulator = FrameAccumulator::default();
            let mut reader = BufReader::new(stdout);
            let mut buffer = [0u8; 64 * 1024];

            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        for (header, body) in accumulator.push(&buffer[..size]) {
                            bridge.on_frame(&handle, header, body);
                        }
                    }
                    Err(error) => {
                        eprintln!("[server] 读取本地服务输出失败：{error}");
                        break;
                    }
                }
            }

            // stdout EOF 意味着子进程已经结束：立刻标记不可用，让前端的请求
            // 快速失败而不是傻等就绪超时。
            // 但如果期间已经重启过（代次变了），这个 EOF 属于旧进程，
            // 既不能把新进程标记成已死，也不能对外播报"服务已退出"。
            let is_current = bridge.is_current(generation);
            bridge.mark_dead_if_current(generation);

            if is_current && !SHUTTING_DOWN.load(Ordering::SeqCst) {
                eprintln!("[server] 本地服务进程已退出。");
                append_log("[exit] 本地服务进程已退出。\n");
                if let Some(tray) = handle.tray_by_id(crate::tray::TRAY_ID) {
                    let _ = tray.set_tooltip(Some("Scoop Manager（本地服务已退出）"));
                }
                let _ = tauri::Emitter::emit(&handle, "backend-exit", ());
            }
        });
    }

    // ---- stderr：全部日志落盘
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                append_log(&line);
                append_log("\n");
            }
        });
    }

    Ok(())
}

// ---------------------------------------------------------------- 停止

fn kill_child(app: &AppHandle) {
    let bridge = app.state::<Bridge>();
    if let Some(mut child) = bridge.take_child() {
        let _ = child.kill();
        let _ = child.wait();
    }
    bridge.mark_dead();
}

/// 应用退出时调用。
pub fn shutdown(app: &AppHandle) {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);

    let bridge = app.state::<Bridge>();
    // 请 sidecar 先把任务历史落盘（jobManager.flush）再退出。
    // 即便这一帧没送达也没关系：父进程退出后 stdin 被 OS 关闭，sidecar
    // 同样会走优雅退出分支（见 src/server/adapter.ipc.ts 的 stdin 'close'）。
    let _ = bridge.send_control(serde_json::json!({ "type": "shutdown" }));

    if let Some(mut child) = bridge.take_child() {
        // 最多等 2 秒让它自己走完收尾，超时再强杀
        for _ in 0..20 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ---------------------------------------------------------------- 错误提示

pub fn report_fatal(app: &AppHandle, message: &str) {
    eprintln!("[server] {message}");
    append_log(&format!("[fatal] {message}\n"));

    let handle = app.clone();
    app.dialog()
        .message(message.to_string())
        .title("Scoop Manager 启动失败")
        .kind(MessageDialogKind::Error)
        .show(move |_| {
            handle.exit(1);
        });
}

// ---------------------------------------------------------------- 命令

#[tauri::command]
pub fn restart_server(app: AppHandle) -> Result<(), String> {
    kill_child(&app);
    if let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) {
        let _ = tray.set_tooltip(Some("Scoop Manager"));
    }
    spawn(&app)
}

#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = data_dir().ok_or_else(|| "无法定位数据目录。".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_log_file(app: AppHandle) -> Result<(), String> {
    let file = log_file().ok_or_else(|| "无法定位日志文件。".to_string())?;
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if !file.exists() {
        let _ = std::fs::write(&file, "");
    }
    app.opener()
        .open_path(file.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// 用系统默认浏览器打开一个 **http(s)** 链接（应用主页、bucket 源地址等）。
///
/// 为什么不直接把 opener 插件的能力授予前端：`open_url` / `open_path` 会把参数交给
/// 系统 shell 处理，一旦放行 `file:`、`javascript:` 或任意字符串，就等于把
/// "让系统执行/打开某个东西"的能力交给了页面（而页面数据来自第三方 bucket manifest）。
/// 所以这里收口成一条窄命令：只接受 http/https，拒绝控制字符与超长输入。
///
/// 前端在桌面端不会走 `target="_blank"`：WebView 不处理新窗口请求，点击毫无反应。
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let target = url.trim();
    if target.is_empty() || target.len() > 2048 {
        return Err("链接为空或过长。".to_string());
    }
    if target.chars().any(char::is_control) {
        return Err("链接包含非法字符。".to_string());
    }
    let colon = target.find(':').ok_or_else(|| "链接缺少协议前缀。".to_string())?;
    let scheme = target[..colon].to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("只允许打开 http/https 链接（收到 {scheme}:）。"));
    }
    app.opener()
        .open_url(target.to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}
