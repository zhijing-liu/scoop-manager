//! Tauri 外壳。
//!
//! 职责边界：
//!   - 窗口与托盘（tray.rs）
//!   - sidecar 进程生命周期（server.rs）
//!   - WebView ↔ sidecar 的 IPC 桥接（bridge.rs）
//!
//! 业务逻辑一概不在这里：全部由 sidecar 里的 Hono 应用负责，外壳只做搬运。

mod bridge;
mod server;
mod tray;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;

/// 注入用的 IPC 垫片源码。
///
/// 走 `initialization_script` 而不是在 index.html 里加 `<script>` 标签：
/// 前者由 WebView 在**页面任何脚本之前**执行，时序上没有任何不确定性，
/// 也正因如此 public/ 目录才能保持零改动。
const IPC_SHIM: &str = include_str!("../shim/ipc-shim.js");

pub fn run() {
    tauri::Builder::default()
        // single-instance 必须最先注册，否则第二次启动会先把窗口建出来
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            // 插件签名要求 Option<Vec<&str>>，不能传数组切片
            Some(vec!["--autostart"]),
        ))
        .manage(bridge::Bridge::new())
        .invoke_handler(tauri::generate_handler![
            bridge::api_request,
            bridge::api_stream_start,
            bridge::api_stream_cancel,
            server::restart_server,
            server::open_data_dir,
            server::open_log_file,
            server::open_external,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            tray::build(&handle)?;

            // 必须先 spawn 再建窗口：页面一加载就会立刻发起 /api/health 等请求，
            // 若此时 sidecar 还没就位，bridge 会以"服务未在运行"直接失败，
            // 用户看到的就不是加载中而是报错。spawn 本身只有毫秒级开销。
            if let Err(message) = server::spawn(&handle) {
                server::report_fatal(&handle, &message);
            }

            // 页面由 Tauri 从 desktop/ui/ 直接提供（服务模式下才由 Hono 提供）。
            // 窗口立刻可见：首屏接口会等在就绪信号上，比"先空白再出现"体验好。
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Scoop Manager")
                .inner_size(1320.0, 880.0)
                .min_inner_size(960.0, 640.0)
                .center()
                .resizable(true)
                .decorations(false)
                .initialization_script(IPC_SHIM)
                .build()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口 = 最小化到托盘，而不是退出：服务要继续常驻，
            // 否则用户点一下 X 就会中断正在跑的 scoop 任务。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用构建失败")
        .run(|app, event| {
            // 真正退出前回收 sidecar（先发 shutdown 控制帧，超时再强杀）
            if let tauri::RunEvent::Exit = event {
                server::shutdown(app);
            }
        });
}
