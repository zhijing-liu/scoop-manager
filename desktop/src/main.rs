// release 构建下不附带控制台窗口；debug 下保留，方便直接看到 eprintln 输出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    scoop_manager_desktop_lib::run();
}
