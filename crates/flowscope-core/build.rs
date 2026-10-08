//! 构建期兜底：rust-embed 在编译期读取 `frontend/dist`，dist 缺失会直接编译
//! 失败。本脚本保证 `../../frontend/dist/index.html` 至少存在——缺失时创建
//! 目录并写入占位页（正常流程先在 frontend 执行 `npm run build`；已有 dist
//! 时不动任何文件）。

use std::path::PathBuf;

fn main() {
    let manifest =
        std::env::var("CARGO_MANIFEST_DIR").expect("build script 必有 CARGO_MANIFEST_DIR");
    let dist = PathBuf::from(manifest)
        .ancestors()
        .nth(2)
        .expect("flowscope-core 应位于 <workspace>/crates/flowscope-core")
        .join("frontend")
        .join("dist");
    let index = dist.join("index.html");
    if index.is_file() {
        return;
    }
    std::fs::create_dir_all(&dist)
        .unwrap_or_else(|e| panic!("创建前端占位目录 {} 失败: {e}", dist.display()));
    std::fs::write(&index, placeholder_html())
        .unwrap_or_else(|e| panic!("写占位 index.html 失败: {e}"));
    println!("cargo:warning=frontend/dist 缺失，已写入占位 index.html（请先 npm run build）");
}

fn placeholder_html() -> &'static str {
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
     <title>FlowScope</title></head><body>\
     <p>FlowScope UI 未构建：请先在 frontend 执行 npm run build</p>\
     </body></html>"
}
