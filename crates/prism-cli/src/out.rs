//! Console-safe line output: `outln!`/`errln!`/`out!` mirror `println!`/
//! `eprintln!`/`print!`, but on a Windows console they end lines with `\r\n`
//! and convert embedded `\n` too. A Windows console can run with newline
//! auto-return disabled (WSL interop's conhost does, for VT passthrough), and
//! there a bare `\n` moves down without returning the carriage, stair-stepping
//! every plain line (the loader is immune: its frames start with `\r`).
//! Redirected streams keep plain `\n`, so piped output is byte-identical.

use std::fmt;
use std::io::{IsTerminal, Write};
use std::sync::OnceLock;

fn stdout_crlf() -> bool {
    static V: OnceLock<bool> = OnceLock::new();
    cfg!(windows) && *V.get_or_init(|| std::io::stdout().is_terminal())
}

pub fn stderr_tty() -> bool {
    static V: OnceLock<bool> = OnceLock::new();
    *V.get_or_init(|| std::io::stderr().is_terminal())
}

fn stderr_crlf() -> bool {
    cfg!(windows) && stderr_tty()
}

fn emit(w: &mut impl Write, args: fmt::Arguments, crlf: bool, newline: bool) {
    if crlf {
        let mut s = args.to_string().replace('\n', "\r\n");
        if newline {
            s.push_str("\r\n");
        }
        let _ = w.write_all(s.as_bytes());
    } else if newline {
        let _ = writeln!(w, "{args}");
    } else {
        let _ = write!(w, "{args}");
    }
}

pub fn out_line(args: fmt::Arguments) {
    emit(&mut std::io::stdout().lock(), args, stdout_crlf(), true);
}

pub fn out_raw(args: fmt::Arguments) {
    emit(&mut std::io::stdout().lock(), args, stdout_crlf(), false);
}

pub fn err_line(args: fmt::Arguments) {
    emit(&mut std::io::stderr().lock(), args, stderr_crlf(), true);
}

macro_rules! outln {
    () => { $crate::out::out_line(format_args!("")) };
    ($($arg:tt)*) => { $crate::out::out_line(format_args!($($arg)*)) };
}

macro_rules! out {
    ($($arg:tt)*) => { $crate::out::out_raw(format_args!($($arg)*)) };
}

macro_rules! errln {
    () => { $crate::out::err_line(format_args!("")) };
    ($($arg:tt)*) => { $crate::out::err_line(format_args!($($arg)*)) };
}

pub(crate) use {errln, out, outln};
