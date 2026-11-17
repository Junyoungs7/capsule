// 미니 터미널 (떠 있는 창 '터미널'): ConPTY(portable-pty) 셸 1개 + xterm.js (창을 열 때만 로드).
// 셸은 창과 따로 산다 — 창을 닫아도 명령은 계속 돌고, 끝나면 Island 가 완료/실패를 알린다.
// 기본 셸 = Windows PowerShell. 프롬프트 함수가 OSC 9999 로 '명령 끝(성공 여부 · 명령 · 폴더)'을 알린다 (VS Code 셸 통합과 같은 방식).
// '아라에서 이어서 하기' = 아라의 문서화된 CLI 만 (ara status → ara open → ara terminal create, cwd = 이 셸의 폴더).
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

const SCROLLBACK: usize = 256 * 1024; // 창을 다시 열면 보여 줄 출력 (바이트)

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Clone, Serialize, Default, Debug, PartialEq)]
pub struct TermState {
    pub running: bool,
    pub cmd: String,
    pub cwd: String,
    pub alive: bool,
}

struct Shared {
    st: TermState,
    started: Option<Instant>,
    typed: String,  // 프롬프트 이후 친 글자 (실행 중 표시용 — 확정 명령은 프롬프트가 알려 준다)
    hist_id: i64,   // 마지막으로 끝난 명령의 기록 번호 (빈 Enter 구별)
    last: String,   // 마지막으로 끝난 명령 (셸 기록 그대로 — 아라 --command)
    esc: bool,      // 키 입력 중 ESC 시퀀스 (화살표·포커스 보고) — 글자로 치지 않는다
    buf: Vec<u8>,   // 스크롤백
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 프롬프트: 명령이 끝날 때마다 ESC ] 9999 ; hera ; <기록번호> ; <성공 1/0> ; <명령 b64> ; <폴더 b64> BEL  + 보이는 프롬프트
const INIT: &str = r#"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
function global:prompt {
  $ok = $?
  $h = Get-History -Count 1
  $id = if ($h) { $h.Id } else { 0 }
  $b64 = { param($s) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$s)) }
  $cmd = if ($h) { & $b64 $h.CommandLine } else { '' }
  $loc = $executionContext.SessionState.Path.CurrentLocation.ProviderPath
  "$([char]27)]9999;hera;$id;$([int]$ok);$cmd;$(& $b64 $loc)$([char]7)PS $loc> "
}
"#;

fn b64(s: &str) -> Option<String> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = vec![];
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes().filter(|c| *c != b'=') {
        acc = (acc << 6) | T.iter().position(|t| *t == c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 출력에서 OSC 9999 표지 찾기 → (기록번호, 성공, 명령, 폴더). carry = 끝이 잘린 표지는 다음 조각으로.
pub fn scan(carry: &mut Vec<u8>, chunk: &[u8]) -> Vec<(i64, bool, String, String)> {
    carry.extend_from_slice(chunk);
    let mut found = vec![];
    let pat = b"\x1b]9999;hera;";
    loop {
        let Some(i) = carry.windows(pat.len()).position(|w| w == pat) else {
            // 표지 앞부분만 걸쳐 있을 수 있다 → 끝 몇 바이트만 남김
            let keep = carry.len().min(pat.len());
            carry.drain(..carry.len() - keep);
            break;
        };
        let Some(end) = carry[i..].iter().position(|&b| b == 7) else {
            carry.drain(..i);
            if carry.len() > 64 * 1024 {
                carry.clear(); // 망가진 표지
            }
            break;
        };
        let body = String::from_utf8_lossy(&carry[i + pat.len()..i + end]).into_owned();
        carry.drain(..i + end + 1);
        let p: Vec<&str> = body.split(';').collect();
        if p.len() == 4 {
            found.push((p[0].parse().unwrap_or(0), p[1] == "1", b64(p[2]).unwrap_or_default(), b64(p[3]).unwrap_or_default()));
        }
    }
    found
}

fn enc64(b: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut enc = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            enc.push(if k <= c.len() { T[(n >> (18 - 6 * k) & 63) as usize] as char } else { '=' });
        }
    }
    enc
}

fn emit_state(app: &AppHandle) {
    if let Some(s) = SHARED.lock().unwrap().as_ref() {
        let _ = app.emit("term-state", &s.st);
    }
}

fn shell() -> CommandBuilder {
    // -EncodedCommand = UTF-16LE base64 (따옴표 걱정 없음)
    let enc = enc64(&INIT.encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<u8>>());
    let mut cmd = CommandBuilder::new(if cfg!(windows) { "powershell.exe" } else { "/bin/zsh" });
    if cfg!(windows) {
        cmd.args(["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &enc]);
    }
    cmd
}

/// 셸 시작 (이미 있으면 그대로) → 지금까지의 출력(스크롤백)
pub fn start(app: &AppHandle, cols: u16, rows: u16) -> Result<String, String> {
    let _ = APP.set(app.clone());
    let mut sess = SESSION.lock().unwrap();
    if sess.is_some() {
        if let Some(s) = sess.as_ref() {
            let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
        let sh = SHARED.lock().unwrap();
        return Ok(sh.as_ref().map(|s| String::from_utf8_lossy(&s.buf).into_owned()).unwrap_or_default());
    }
    let pty = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut cmd = shell();
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    cmd.cwd(&home);
    let child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    *SHARED.lock().unwrap() = Some(Shared { st: TermState { running: false, cmd: String::new(), cwd: home, alive: true }, started: None, typed: String::new(), hist_id: -1, last: String::new(), esc: false, buf: vec![] });
    *sess = Some(Session { master: pty.master, writer, child });
    drop(sess);
    let a = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut carry = vec![];
        let mut pending: Vec<u8> = vec![]; // 잘린 UTF-8 꼬리
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = &buf[..n];
            let marks = scan(&mut carry, chunk);
            pending.extend_from_slice(chunk);
            let cut = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(), // 다음 조각에 이어짐
                Err(_) => pending.len(),
            };
            let text = String::from_utf8_lossy(&pending[..cut]).into_owned();
            pending.drain(..cut);
            {
                let mut sh = SHARED.lock().unwrap();
                if let Some(s) = sh.as_mut() {
                    s.buf.extend_from_slice(text.as_bytes());
                    if s.buf.len() > SCROLLBACK {
                        let drop_n = s.buf.len() - SCROLLBACK;
                        let at = (drop_n..s.buf.len()).find(|&i| std::str::from_utf8(&s.buf[i..]).is_ok()).unwrap_or(drop_n);
                        s.buf.drain(..at);
                    }
                }
            }
            if !text.is_empty() {
                let _ = a.emit_to("float-term", "term-out", &text);
            }
            for (id, ok, cmd, cwd) in marks {
                finished(&a, id, ok, cmd, cwd);
            }
        }
        // 셸이 끝남 (exit 입력 · 강제 종료)
        *SESSION.lock().unwrap() = None;
        if let Some(s) = SHARED.lock().unwrap().as_mut() {
            s.st = TermState { alive: false, ..Default::default() };
        }
        emit_state(&a);
        let _ = a.emit_to("float-term", "term-exit", ());
    });
    emit_state(app);
    Ok(String::new())
}

/// 프롬프트가 다시 뜸 = 명령이 끝남. 기록 번호가 그대로면 빈 Enter (알리지 않음)
fn finished(app: &AppHandle, id: i64, ok: bool, cmd: String, cwd: String) {
    let done = {
        let mut sh = SHARED.lock().unwrap();
        let Some(s) = sh.as_mut() else { return };
        let first = s.hist_id < 0;
        let new = id != s.hist_id && !first;
        s.hist_id = id;
        let ms = s.started.take().map_or(0, |t| t.elapsed().as_millis() as u64);
        s.st.running = false;
        s.st.cwd = cwd.clone();
        s.typed.clear();
        if new {
            s.st.cmd = cmd.clone();
            s.last = cmd.clone();
        }
        (new && s.st.alive).then_some(ms)
    };
    emit_state(app);
    if let Some(ms) = done {
        let focused = app.get_webview_window("float-term").and_then(|w| w.is_focused().ok()).unwrap_or(false);
        let _ = app.emit("term-done", json!({ "ok": ok, "cmd": cmd, "cwd": cwd, "ms": ms, "focused": focused }));
    }
}

/// 키 입력 (xterm onData). Enter 를 치면 '실행 중' (명령 이름은 친 글자 — 기록 불러오기면 끝날 때 바로잡힘)
pub fn write(app: &AppHandle, data: &str) -> Result<(), String> {
    let mut sess = SESSION.lock().unwrap();
    let s = sess.as_mut().ok_or("터미널이 꺼져 있어요")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    let _ = s.writer.flush();
    drop(sess);
    let mut changed = false;
    if let Some(sh) = SHARED.lock().unwrap().as_mut() {
        for c in data.chars() {
            if c == '\x1b' {
                sh.esc = true;
                continue;
            }
            if sh.esc {
                sh.esc = !(c.is_ascii_alphabetic() || c == '~');
                continue;
            }
            match c {
                '\r' if !sh.st.running && !sh.typed.trim().is_empty() => {
                    sh.st.running = true;
                    sh.st.cmd = sh.typed.trim().to_string();
                    sh.started = Some(Instant::now());
                    changed = true;
                }
                '\r' => sh.typed.clear(),
                '\x7f' | '\x08' => {
                    sh.typed.pop();
                }
                '\x03' => sh.typed.clear(),
                c if !c.is_control() && !sh.st.running => sh.typed.push(c),
                _ => {}
            }
        }
    }
    if changed {
        emit_state(app);
    }
    Ok(())
}

pub fn resize(cols: u16, rows: u16) {
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
        let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

pub fn kill() {
    if let Some(mut s) = SESSION.lock().unwrap().take() {
        let _ = s.child.kill();
    }
}

pub fn state() -> TermState {
    SHARED.lock().unwrap().as_ref().map(|s| s.st.clone()).unwrap_or_default()
}

/* ── 아라에서 이어서 하기 (문서화된 CLI 만 — 이름 있는 파이프·토큰은 쓰지 않는다) ── */
fn ara_cli() -> std::path::PathBuf {
    // 시험: HERA_ARA_CLI = 가짜 CLI (사용자의 아라에 탭을 만들지 않게)
    if let Ok(p) = std::env::var("HERA_ARA_CLI") {
        return p.into();
    }
    let p = std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join(r"Programs\ARA\resources\bin\ara.cmd");
    if p.exists() { p } else { "ara.cmd".into() } // PATH
}

fn ara(args: &[&str], cwd: &str) -> Result<serde_json::Value, String> {
    // .cmd 를 직접 실행: Rust 표준 라이브러리가 배치 파일 인자를 안전하게 이스케이프한다 (명령에 & · | 가 있어도 그대로 한 인자)
    let mut c = std::process::Command::new(ara_cli());
    c.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = c.output().map_err(|e| format!("아라 CLI를 실행하지 못했어요: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(text.trim()).map_err(|_| format!("아라 CLI 응답을 읽지 못했어요 (exit {:?}) {}", out.status.code(), String::from_utf8_lossy(&out.stderr).trim()))
}

/// ara status → (꺼져 있으면) ara open → ara terminal create --title "Hera에서" [--command <마지막 명령>], cwd = 이 셸의 폴더
pub fn to_ara(with_cmd: bool) -> Result<String, String> {
    let st = state();
    let cwd = if st.cwd.is_empty() { std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()) } else { st.cwd.clone() };
    let s = ara(&["status", "--json"], &cwd)?;
    if s["result"]["app"]["running"] != true {
        let o = ara(&["open", "--json"], &cwd)?;
        if o["ok"] == false {
            return Err(format!("아라를 켜지 못했어요: {}", o["error"]));
        }
    }
    let mut args = vec!["terminal", "create", "--title", "Hera에서", "--json"];
    let cmd = SHARED.lock().unwrap().as_ref().map(|s| s.last.clone()).unwrap_or_default();
    if with_cmd && !cmd.is_empty() {
        args.extend(["--command", cmd.as_str()]);
    }
    let r = ara(&args, &cwd)?;
    if r["ok"] == false {
        return Err(format!("아라 탭을 만들지 못했어요: {}", r["error"]));
    }
    Ok(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_across_chunks() {
        let mut carry = vec![];
        // 명령 "npm run build" 성공, 폴더 D:\AI\hera — 두 조각으로 잘려 옴
        let body = "\x1b]9999;hera;7;1;bnBtIHJ1biBidWlsZA==;RDpcQUlcaGVyYQ==\x07PS D:\\AI\\hera> ";
        let (a, b) = body.split_at(20);
        assert!(scan(&mut carry, format!("output\r\n{a}").as_bytes()).is_empty());
        let m = scan(&mut carry, b.as_bytes());
        assert_eq!(m, vec![(7, true, "npm run build".into(), r"D:\AI\hera".into())]);
        // 실패 + 한글 폴더
        let m = scan(&mut carry, "x\x1b]9999;hera;8;0;bnBtIHRlc3Q=;Qzpc7ZWc6riA\x07".as_bytes());
        assert_eq!(m, vec![(8, false, "npm test".into(), "C:\\한글".into())]);
        assert!(carry.len() <= 13);
    }

    #[test]
    fn b64_roundtrip_utf8() {
        assert_eq!(b64("7ZWc6riA").as_deref(), Some("한글"));
        assert_eq!(b64("").as_deref(), Some(""));
        assert_eq!(enc64(&[0x61, 0, 0x62, 0]), "YQBiAA=="); // "ab" UTF-16LE (-EncodedCommand)
        assert_eq!(enc64(b"hera"), "aGVyYQ==");
        assert_eq!(b64(&enc64("한글 터미널".as_bytes())).as_deref(), Some("한글 터미널"));
    }
}
