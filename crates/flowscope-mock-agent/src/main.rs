//! Thin shell around [`flowscope_mock_agent::serve`]: resolves the script path
//! from `--script <path>` / `--script=<path>` (fallback: env `MOCK_SCRIPT`)
//! and exits with the code `serve` returns.

use std::ffi::OsString;
use std::path::PathBuf;

fn main() {
    let script_path = parse_script_arg(std::env::args_os().skip(1))
        .or_else(|| std::env::var_os("MOCK_SCRIPT").map(PathBuf::from));
    let Some(script_path) = script_path else {
        eprintln!("usage: flowscope-mock-agent --script <path> (or set MOCK_SCRIPT)");
        std::process::exit(2);
    };
    std::process::exit(flowscope_mock_agent::serve(&script_path));
}

fn parse_script_arg(args: impl Iterator<Item = OsString>) -> Option<PathBuf> {
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        let arg = arg.to_string_lossy().into_owned();
        if arg == "--script" {
            return args.next().map(PathBuf::from);
        }
        if let Some(path) = arg.strip_prefix("--script=") {
            return Some(PathBuf::from(path));
        }
    }
    None
}
