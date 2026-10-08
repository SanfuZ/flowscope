//! 前端静态资源嵌入（rust-embed，编译期打包 `frontend/dist`）。
//!
//! 单文件分发形态（`bin/server.rs`、Tauri 桌面壳）不再依赖磁盘 dist：
//! `router_with_static` 收到 `dist=None` 时以本模块为非 `/api` 请求兜底。
//! `debug-embed` feature 使 dev/test 同样走编译期嵌入路径（与 release 一致）。
//!
//! 路径安全：拒绝含 `..` 的请求路径；rust-embed 键为去前导 `/` 的正斜杠
//! 相对路径（如 `assets/index-abc123.js`），按精确键匹配，未命中且末段带
//! 扩展名 → 404，否则回退 `index.html`（SPA history 路由）。

use rust_embed::RustEmbed;

/// vite 构建产物（缺失时由 build.rs 写入占位 index.html 保证可编译）。
#[derive(RustEmbed)]
#[folder = "../../frontend/dist"]
struct EmbeddedAssets;

/// 嵌入键列出（测试用：动态挑一个真实 `.js` 键断言可达，不写死哈希文件名）。
#[cfg(test)]
pub(crate) fn embedded_keys() -> Vec<String> {
    EmbeddedAssets::iter().map(|k| k.into_owned()).collect()
}

/// 按请求路径取嵌入文件，返回 `(内容, MIME)`。
/// `"/"`→`index.html`；拒绝含 `..`；其余去前导 `/` 后按嵌入键精确匹配。
pub fn serve_embedded(path: &str) -> Option<(Vec<u8>, &'static str)> {
    if path.contains("..") {
        return None;
    }
    let key = path.trim_start_matches('/');
    let key = if key.is_empty() { "index.html" } else { key };
    let file = EmbeddedAssets::get(key)?;
    Some((file.data.to_vec(), mime_of(key)))
}

/// MIME 小表：按**最后一段**扩展名判断（哈希文件名可含多个点）；
/// 未知扩展名 → application/octet-stream。
fn mime_of(key: &str) -> &'static str {
    let ext = key.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}
