/**
 * 构建脚本。
 *
 * 除了 Tauri 自己的代码生成，还额外把编译目标三元组导出为编译期环境变量：
 * 开发态下 sidecar 的文件名形如 `scoop-manager-x86_64-pc-windows-msvc.exe`，
 * 运行期需要拼出这个文件名，硬编码会导致换平台/换架构就找不到文件。
 */
fn main() {
    let target = std::env::var("TARGET").unwrap_or_else(|_| "x86_64-pc-windows-msvc".to_string());
    println!("cargo:rustc-env=SCOOP_MANAGER_TARGET_TRIPLE={target}");

    tauri_build::build()
}
