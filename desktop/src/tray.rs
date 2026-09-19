//! 系统托盘。
//!
//! 菜单刻意**不含「在浏览器中打开」**：桌面端走 IPC，不监听任何端口，
//! 没有可以交给浏览器的地址。服务模式（HTTP）才有那个概念。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::server;

pub const TRAY_ID: &str = "main-tray";

const ID_STATUS: &str = "tray.status";
const ID_SHOW: &str = "tray.show";
const ID_RESTART: &str = "tray.restart";
const ID_AUTOSTART: &str = "tray.autostart";
const ID_LOGS: &str = "tray.logs";
const ID_DATA: &str = "tray.data";
const ID_QUIT: &str = "tray.quit";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);

    // 只读信息项：让用户一眼确认"没有占用端口"这件事
    let status = MenuItem::with_id(app, ID_STATUS, "传输：IPC（不占用端口）", false, None::<&str>)?;
    let show = MenuItem::with_id(app, ID_SHOW, "显示主界面", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, ID_RESTART, "重启服务", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, ID_AUTOSTART, "开机自动启动", true, autostart_enabled, None::<&str>)?;
    let logs = MenuItem::with_id(app, ID_LOGS, "查看日志", true, None::<&str>)?;
    let data = MenuItem::with_id(app, ID_DATA, "打开数据目录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &show,
            &restart,
            &PredefinedMenuItem::separator(app)?,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &logs,
            &data,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Scoop Manager")
        .menu(&menu)
        // Windows 习惯：右键出菜单，左键直接开窗
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn on_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        show_window(tray.app_handle());
    }
}

fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        ID_SHOW => show_window(app),

        ID_RESTART => {
            if let Err(message) = server::restart_server(app.clone()) {
                server::report_fatal(app, &message);
            }
        }

        ID_AUTOSTART => {
            let manager = app.autolaunch();
            let enabled = manager.is_enabled().unwrap_or(false);
            let _ = if enabled { manager.disable() } else { manager.enable() };
        }

        ID_LOGS => {
            let _ = server::open_log_file(app.clone());
        }

        ID_DATA => {
            let _ = server::open_data_dir(app.clone());
        }

        ID_QUIT => {
            server::shutdown(app);
            app.exit(0);
        }

        // 只读信息项
        ID_STATUS => {}

        _ => {}
    }
}
