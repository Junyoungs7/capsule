// Hera Link 입력 엔진: Deskflow 의 deskflow-core 를 숨김 자식 프로세스로 (서버 모드). GPL-2.0 — 개인 사용, LICENSE 동봉.
// - 엔진 파일은 리소스(link/)에서 %APPDATA%\dev.hera.dock\link\ 로 복사해 그곳에서 실행 → 'portable mode'
//   (exe 옆 settings\Deskflow.conf 가 있으면 TLS 인증서·trusted-clients 도 그 폴더) — 사용자의 Deskflow(ProgramData)와 완전히 분리.
// - 항상 --new-instance. 종료는 우리 자식만 죽인다 (Job 객체, KILL_ON_JOB_CLOSE → Hera 가 죽어도 같이 죽음).
//   ⚠ Global\DeskflowClose 이벤트는 절대 신호하지 않는다 — 사용자의 Deskflow 코어까지 꺼진다.
// - 사용자의 Deskflow 코어가 돌고 있으면(같은 Global 이벤트를 이미 가짐) 내장 엔진은 시작조차 못 한다 → 감지해서 패널에 안내만.
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

/// store `link.cfg` (link.enabled 는 따로)
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Cfg {
    pub me: String,
    pub peer: String,
    pub side: String, // left / right / top / bottom — 이 PC 기준 맥의 위치
    pub port: u16,
    pub tls: bool,
    pub double_tap: bool, // 가장자리를 두 번 쳐야 넘어감 (사용자 Deskflow 에서 가져옴)
    pub file_port: u16,
}

impl Default for Cfg {
    fn default() -> Self {
        Cfg {
            me: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows".into()),
            peer: "MacBook".into(),
            side: "right".into(),
            port: 24800,
            tls: true,
            double_tap: false,
            file_port: 24810,
        }
    }
}

fn dir(side: &str) -> (&'static str, &'static str) {
    match side {
        "left" => ("left", "right"),
        "top" => ("up", "down"),
        "bottom" => ("down", "up"),
        _ => ("right", "left"),
    }
}

/// 엔진 서버 설정 파일 (screens / links / options)
pub fn server_conf(c: &Cfg) -> String {
    let (go, back) = dir(&c.side);
    let mut s = format!("section: screens\n\t{me}:\n\t{peer}:\nend\n\nsection: links\n\t{me}:\n\t\t{go} = {peer}\n\t{peer}:\n\t\t{back} = {me}\nend\n\nsection: options\n", me = c.me, peer = c.peer);
    if c.double_tap {
        s += "\tswitchDoubleTap = 250\n";
    }
    s += "end\n";
    s
}

/// 엔진 설정 INI (portable: exe 옆 settings\Deskflow.conf)
pub fn settings_ini(c: &Cfg, conf: &Path, cert: &Path) -> String {
    let p = |x: &Path| x.display().to_string().replace('\\', "/");
    format!(
        "[core]\ncomputerName={me}\nport={port}\ncoreMode=2\npreventSleep=false\n\n[server]\nexternalConfig=true\nexternalConfigFile={conf}\nprotocol=barrier\nenableClipboard=true\nclipboardSize=3\nenableSwitchDoubleTap={dt}\nswitchDoubleTap=250\n\n[security]\ntlsEnabled={tls}\ncheckPeerFingerprints=true\ncertificate={cert}\n\n[log]\nlevel=INFO\n",
        me = c.me,
        port = c.port,
        conf = p(conf),
        dt = c.double_tap,
        tls = c.tls,
        cert = p(cert)
    )
}

#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LogEv {
    Connected { name: String },
    Disconnected { name: String },
    Switch { from: String, to: String },
    Fingerprint { fp: String },
    Untrusted,
    Error { msg: String },
}

fn quoted(s: &str, i: usize) -> String {
    s.split('"').nth(i * 2 + 1).unwrap_or("").to_string()
}

/// 엔진 로그 한 줄 → 이벤트. 형식: "[2026-11-15T12:03:00.851] INFO: switch from "A" to "B" at 1919,500"
pub fn parse_line(line: &str) -> Option<LogEv> {
    let (level, msg) = line.split_once("] ").map(|(_, r)| r).unwrap_or(line).split_once(": ")?;
    let has = |p: &str| msg.contains(p);
    if has("switch from \"") || has("jump from \"") {
        return Some(LogEv::Switch { from: quoted(msg, 0), to: quoted(msg, 1) });
    }
    if has("has connected") || has("accepted client connection") {
        return Some(LogEv::Connected { name: quoted(msg, 0) });
    }
    if has("disconnecting client") || has("has disconnected") || has("forced disconnection of client") {
        return Some(LogEv::Disconnected { name: quoted(msg, 0) });
    }
    if let Some(fp) = msg.strip_prefix("peer fingerprint: ") {
        return Some(LogEv::Fingerprint { fp: norm_fp(fp) });
    }
    if has("fingerprint does not match trusted fingerprint") {
        return Some(LogEv::Untrusted);
    }
    if level == "FATAL" || level == "ERROR" {
        let msg = msg.trim().to_string();
        // 사람이 읽을 원인 (패널·Island 표시용)
        let human = if msg.contains("tls certificate") || msg.contains("could not use tls") {
            "TLS 인증서가 없어요 — 'Deskflow 설정 가져오기'로 가져오거나 TLS 를 끄세요".to_string()
        } else if msg.contains("failed to create event for windows event loop") {
            "다른 Deskflow 가 실행 중이에요 — Deskflow 앱을 먼저 종료하세요".to_string()
        } else if msg.contains("listen") || msg.contains("bind") || msg.contains("address already in use") {
            format!("포트를 열 수 없어요 (다른 프로그램이 사용 중?) — {msg}")
        } else {
            msg
        };
        return Some(LogEv::Error { msg: human });
    }
    None
}

/// "SHA256:AA:BB…" / "sha256:aabb…" / "aa:bb…" → "aabb…" (소문자 hex)
pub fn norm_fp(s: &str) -> String {
    let s = s.trim();
    let s = s.rsplit_once("sha256:").or_else(|| s.rsplit_once("SHA256:")).map(|(_, r)| r).unwrap_or(s);
    s.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_lowercase()
}

/// trusted-clients 파일 내용에 지문 추가 (이미 있으면 그대로). 형식 = Deskflow 1.27 "v2:sha256:<hex>"
pub fn trust_line(existing: &str, fp: &str) -> Option<String> {
    let line = format!("v2:sha256:{}", norm_fp(fp));
    if existing.lines().any(|l| l.trim() == line) {
        return None;
    }
    let mut s = existing.trim_end().to_string();
    if !s.is_empty() {
        s.push('\n');
    }
    Some(s + &line + "\n")
}

/// PEM 인증서의 SHA-256 지문 (맥 쪽 trusted-servers 에 넣을 값 — 파일 채널 hello 로 건넨다)
pub fn cert_fp(pem: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    let b64: String = pem.split("-----BEGIN CERTIFICATE-----").nth(1)?.split("-----END CERTIFICATE-----").next()?.chars().filter(|c| !c.is_whitespace()).collect();
    let der = b64_decode(&b64)?;
    Some(crate::link_files::hex(&Sha256::digest(der)))
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = vec![];
    let (mut acc, mut bits) = (0u32, 0);
    for &c in s.as_bytes().iter().filter(|&&c| c != b'=') {
        acc = (acc << 6) | val(c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// 사용자의 Deskflow 1.27 설정 (읽기 전용): %APPDATA%\Deskflow\Deskflow.conf + C:\ProgramData\Deskflow\deskflow-server.conf
pub fn parse_deskflow(ini: &str, server_conf: &str) -> Cfg {
    let mut c = Cfg::default();
    let mut sec = String::new();
    for l in ini.lines().map(str::trim) {
        if let Some(s) = l.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            sec = s.to_string();
            continue;
        }
        let Some((k, v)) = l.split_once('=') else { continue };
        match (sec.as_str(), k) {
            ("core", "computerName") if !v.is_empty() => c.me = v.into(),
            ("core", "port") => c.port = v.parse().unwrap_or(c.port),
            ("server", "enableSwitchDoubleTap") => c.double_tap = v == "true",
            ("security", "tlsEnabled") => c.tls = v != "false",
            _ => {}
        }
    }
    // links: "<me>:" 다음 줄 "right = <peer>"
    let mut cur = String::new();
    for l in server_conf.lines().map(str::trim) {
        if let Some(name) = l.strip_suffix(':') {
            cur = name.to_string();
        } else if let Some((d, peer)) = l.split_once('=') {
            if cur == c.me {
                let side = match d.trim().split('(').next().unwrap_or("") {
                    "left" => "left",
                    "up" => "top",
                    "down" => "bottom",
                    _ => "right",
                };
                c.side = side.into();
                c.peer = peer.trim().split('(').next().unwrap_or("").trim().to_string();
            }
        }
    }
    c
}

/* ── 실행 (Windows) ── */

#[derive(Clone, Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String, // off / starting / waiting / connected / blocked / error
    pub detail: String,
    pub peer: String,
    pub on_peer: bool, // 커서가 맥 화면에 있음
    pub fingerprint: String, // 신뢰 대기 중인 맥 지문
}

static STATUS: Mutex<Status> = Mutex::new(Status { state: String::new(), detail: String::new(), peer: String::new(), on_peer: false, fingerprint: String::new() });
static CTL: OnceLock<Sender<()>> = OnceLock::new();

pub fn status() -> Status {
    let s = STATUS.lock().unwrap().clone();
    if s.state.is_empty() { Status { state: "off".into(), ..s } } else { s }
}

fn set(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    let s = {
        let mut st = STATUS.lock().unwrap();
        f(&mut st);
        st.clone()
    };
    let _ = app.emit("link-status", s);
}

pub fn engine_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("link"))
}

pub fn read_cfg(app: &AppHandle) -> (bool, Cfg) {
    let Ok(s) = app.store("hera.json") else { return (false, Cfg::default()) };
    let on = s.get("link.enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut c: Cfg = s.get("link.cfg").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    // 빈 이름 = 이 PC 이름 / 기본 맥 이름 (패널은 빈칸에 자리 표시만)
    let d = Cfg::default();
    if c.me.trim().is_empty() {
        c.me = d.me;
    }
    if c.peer.trim().is_empty() {
        c.peer = d.peer;
    }
    (on, c)
}

/// 설정이 바뀌었을 때 (패널) — 감독 스레드가 다시 읽는다
pub fn apply() {
    if let Some(tx) = CTL.get() {
        let _ = tx.send(());
    }
}

/// 리소스의 엔진 파일을 앱 데이터로 (없거나 크기가 다를 때만)
fn install(app: &AppHandle, dst: &Path) -> Result<(), String> {
    let src = app.path().resource_dir().map_err(|e| e.to_string())?.join("link");
    if !src.join("deskflow-core.exe").exists() {
        return Err("엔진 파일이 설치에 없어요 (resources/link)".into());
    }
    fn copy(src: &Path, dst: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dst)?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            let (s, d) = (e.path(), dst.join(e.file_name()));
            if e.file_type()?.is_dir() {
                copy(&s, &d)?;
            } else if std::fs::metadata(&d).map(|m| m.len()).ok() != Some(e.metadata()?.len()) {
                std::fs::copy(&s, &d)?;
            }
        }
        Ok(())
    }
    copy(&src, dst).map_err(|e| e.to_string())
}

fn prepare(app: &AppHandle, c: &Cfg) -> Result<PathBuf, String> {
    let d = engine_dir(app).ok_or("앱 데이터 폴더 없음")?;
    install(app, &d)?;
    let (conf, tls) = (d.join("server.conf"), d.join("settings").join("tls"));
    std::fs::create_dir_all(&tls).map_err(|e| e.to_string())?;
    let cert = tls.join("deskflow.pem");
    if c.tls && !cert.exists() {
        return Err("TLS 인증서가 없어요 — 'Deskflow 설정 가져오기'로 가져오거나 TLS 를 끄세요".into());
    }
    std::fs::write(&conf, server_conf(c)).map_err(|e| e.to_string())?;
    std::fs::write(d.join("settings").join("Deskflow.conf"), settings_ini(c, &conf, &cert)).map_err(|e| e.to_string())?;
    Ok(d)
}

/// 이 엔진의 서버 TLS 지문 (맥이 신뢰할 값)
pub fn my_fp(app: &AppHandle) -> String {
    engine_dir(app).and_then(|d| std::fs::read_to_string(d.join("settings").join("tls").join("deskflow.pem")).ok()).and_then(|p| cert_fp(&p)).unwrap_or_default()
}

/// 맥 지문 신뢰 (패널/Island 의 '신뢰' 또는 파일 채널 페어링에서)
pub fn trust(app: &AppHandle, fp: &str) -> Result<(), String> {
    if norm_fp(fp).len() != 64 {
        return Err("지문 형식이 아니에요".into());
    }
    let f = engine_dir(app).ok_or("앱 데이터 폴더 없음")?.join("settings").join("tls").join("trusted-clients");
    std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
    let cur = std::fs::read_to_string(&f).unwrap_or_default();
    if let Some(next) = trust_line(&cur, fp) {
        std::fs::write(&f, next).map_err(|e| e.to_string())?;
    }
    set(app, |s| s.fingerprint.clear());
    apply(); // 엔진은 시작 때 파일을 읽는다 → 재시작
    Ok(())
}

/// 'Deskflow 설정 가져오기': 이름·배치·옵션 + TLS 인증서·trusted-clients 를 Hera 엔진 폴더로 복사 (원본은 읽기만)
pub fn import(app: &AppHandle) -> Result<Cfg, String> {
    let appdata = std::env::var("APPDATA").map_err(|e| e.to_string())?;
    let ini = std::fs::read_to_string(Path::new(&appdata).join("Deskflow").join("Deskflow.conf")).map_err(|_| "Deskflow 설정 파일을 찾지 못했어요".to_string())?;
    let pd = Path::new(r"C:\ProgramData\Deskflow");
    let conf = std::fs::read_to_string(pd.join("deskflow-server.conf")).unwrap_or_default();
    let mut c = parse_deskflow(&ini, &conf);
    c.file_port = read_cfg(app).1.file_port;
    let tls = engine_dir(app).ok_or("앱 데이터 폴더 없음")?.join("settings").join("tls");
    std::fs::create_dir_all(&tls).map_err(|e| e.to_string())?;
    for f in ["deskflow.pem", "trusted-clients"] {
        if let Ok(b) = std::fs::read(pd.join("tls").join(f)) {
            std::fs::write(tls.join(f), b).map_err(|e| e.to_string())?;
        }
    }
    if let Ok(s) = app.store("hera.json") {
        s.set("link.cfg", serde_json::to_value(&c).unwrap_or(Value::Null));
    }
    apply();
    Ok(c)
}

#[cfg(windows)]
mod win {
    use windows::core::w;
    use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, HANDLE};
    use windows::Win32::System::JobObjects::*;
    use windows::Win32::System::Threading::{OpenEventW, SYNCHRONIZATION_SYNCHRONIZE};

    /// 사용자의 Deskflow 코어가 돌고 있나: 코어가 만드는 Global\DeskflowClose 이벤트가 있으면(열림 or 접근 거부) 그렇다.
    /// 열기만 하고 절대 SetEvent 하지 않는다. (우리 자식이 돌 때는 부르지 말 것 — 자기 이벤트를 본다)
    pub fn standalone_running() -> bool {
        match unsafe { OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, false, w!("Global\\DeskflowClose")) } {
            Ok(h) => {
                let _ = unsafe { CloseHandle(h) };
                true
            }
            Err(e) => e.code() == ERROR_ACCESS_DENIED.to_hresult(),
        }
    }

    /// Hera 가 죽으면 같이 죽는 Job (프로세스 수명 동안 1개)
    pub fn job() -> Option<isize> {
        static JOB: std::sync::OnceLock<isize> = std::sync::OnceLock::new();
        let h = *JOB.get_or_init(|| unsafe {
            let Ok(j) = CreateJobObjectW(None, None) else { return 0 };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let _ = SetInformationJobObject(j, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32);
            j.0 as isize
        });
        (h != 0).then_some(h)
    }

    pub fn assign(child: &std::process::Child) {
        use std::os::windows::io::AsRawHandle;
        if let Some(j) = job() {
            unsafe {
                let _ = AssignProcessToJobObject(HANDLE(j as _), HANDLE(child.as_raw_handle()));
            }
        }
    }
}

fn spawn(app: &AppHandle, d: &Path) -> Result<Child, String> {
    let mut cmd = Command::new(d.join("deskflow-core.exe"));
    cmd.args(["server", "--new-instance"]).current_dir(d).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("엔진을 시작하지 못했어요: {e}"))?;
    #[cfg(windows)]
    win::assign(&child);
    for out in [child.stdout.take().map(|o| Box::new(o) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|e| Box::new(e) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(ev) = parse_line(&line) {
                    on_log(&app, ev);
                }
            }
        });
    }
    Ok(child)
}

fn on_log(app: &AppHandle, ev: LogEv) {
    let me = read_cfg(app).1.me;
    match &ev {
        LogEv::Connected { name } => set(app, |s| (s.state = "connected".into(), s.peer = if name.is_empty() { s.peer.clone() } else { name.clone() }, s.detail.clear()).2),
        LogEv::Disconnected { .. } => set(app, |s| (s.state = "waiting".into(), s.on_peer = false).1),
        LogEv::Switch { to, .. } => {
            let on_peer = *to != me;
            set(app, |s| (s.on_peer = on_peer, s.state = "connected".into()).1);
            let _ = app.emit("link-switch", json!({ "to": to, "onPeer": on_peer }));
        }
        LogEv::Fingerprint { fp } => STATUS.lock().unwrap().fingerprint = fp.clone(),
        LogEv::Untrusted => {
            let fp = STATUS.lock().unwrap().fingerprint.clone();
            set(app, |s| (s.detail = "새 맥이 연결하려 해요 — 지문을 확인하고 신뢰하세요".into(), s.fingerprint = fp).1);
        }
        LogEv::Error { msg } => set(app, |s| (s.state = "error".into(), s.detail = msg.clone()).1),
    }
}

/// 감독 스레드: 켜짐 → (충돌 검사) → 준비 → 실행 → 죽으면 백오프 재시작. 꺼짐/설정 변경 → 우리 자식만 종료.
pub fn start(app: AppHandle) {
    let (tx, rx) = channel::<()>();
    let _ = CTL.set(tx);
    std::thread::spawn(move || {
        let mut child: Option<(Child, Cfg, Instant)> = None;
        let mut backoff = 1u64;
        loop {
            let (on, cfg) = read_cfg(&app);
            let changed = child.as_ref().is_some_and(|(_, c, _)| *c != cfg);
            if !on || changed {
                if let Some((mut c, _, _)) = child.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                if !on {
                    set(&app, |s| *s = Status { state: "off".into(), ..Default::default() });
                    if rx.recv().is_err() {
                        return;
                    }
                    backoff = 1;
                    continue;
                }
            }
            if child.is_none() {
                #[cfg(windows)]
                if win::standalone_running() {
                    set(&app, |s| (s.state = "blocked".into(), s.detail = "Deskflow 앱(deskflow-core)이 실행 중이에요 — Deskflow 를 먼저 종료하세요".into()).1);
                    if matches!(rx.recv_timeout(Duration::from_secs(5)), Err(RecvTimeoutError::Disconnected)) {
                        return;
                    }
                    continue;
                }
                match prepare(&app, &cfg).and_then(|d| spawn(&app, &d)) {
                    Ok(c) => {
                        set(&app, |s| (s.state = "waiting".into(), s.detail.clear()).1);
                        child = Some((c, cfg.clone(), Instant::now()));
                    }
                    Err(e) => {
                        set(&app, |s| (s.state = "error".into(), s.detail = e).1);
                        if rx.recv().is_err() {
                            return; // 설정을 고칠 때까지 대기
                        }
                        continue;
                    }
                }
            }
            match rx.recv_timeout(Duration::from_secs(1)) {
                Err(RecvTimeoutError::Disconnected) => return,
                Ok(()) => continue, // 설정 다시 읽기
                Err(RecvTimeoutError::Timeout) => {}
            }
            // 죽었나 → 백오프 재시작 (60초 이상 살았으면 백오프 초기화)
            if let Some((c, _, since)) = child.as_mut() {
                if let Ok(Some(code)) = c.try_wait() {
                    backoff = if since.elapsed() > Duration::from_secs(60) { 1 } else { (backoff * 2).min(30) };
                    child = None;
                    set(&app, |s| (s.state = "starting".into(), s.on_peer = false, if s.detail.is_empty() { s.detail = format!("엔진이 멈췄어요 (코드 {code:?}) — {backoff}초 뒤 다시 시작") }).2);
                    if matches!(rx.recv_timeout(Duration::from_secs(backoff)), Err(RecvTimeoutError::Disconnected)) {
                        return;
                    }
                }
            }
        }
    });
}

/* ── 파일 채널 연결 (link_files) ── */
use crate::link_files::{self as lf, Conn};
use std::sync::Arc;

static CONN: Mutex<Option<Arc<Conn>>> = Mutex::new(None);
static FILES: OnceLock<()> = OnceLock::new();

fn files_cfg(app: &AppHandle) -> lf::Config {
    let s = app.store("hera.json").ok();
    let get = |k: &str| s.as_ref().and_then(|s| s.get(k)).and_then(|v| v.as_str().map(String::from));
    // 장기 X25519 키: 처음 한 번 만들어 store 에 (hera.json 은 사용자 프로필 안)
    let secret = get("link.key").and_then(|k| lf::unhex32(&k)).unwrap_or_else(|| {
        let k = lf::random32();
        if let Some(s) = &s {
            s.set("link.key", lf::hex(&k));
        }
        k
    });
    lf::Config {
        name: read_cfg(app).1.me,
        secret,
        known_peer: get("link.peerPk").and_then(|k| lf::unhex32(&k)),
        engine_fp: my_fp(app),
        downloads: app.path().download_dir().unwrap_or_else(|_| std::env::temp_dir()).join("Hera"),
    }
}

fn sink(app: &AppHandle) -> lf::Sink {
    let app = app.clone();
    Arc::new(move |e: lf::Event| {
        match &e {
            lf::Event::Paired { pk, name, fp } => {
                if let Ok(s) = app.store("hera.json") {
                    s.set("link.peerPk", pk.clone());
                    s.set("link.peerName", name.clone());
                }
                // 맥 엔진(클라이언트)의 TLS 지문도 함께 신뢰 → 엔진 첫 연결에서 따로 묻지 않음
                if !fp.is_empty() {
                    let _ = trust(&app, fp);
                }
            }
            lf::Event::Received { path, .. } => {
                let _ = app.emit_to("dock", "link-received", path.clone());
            }
            lf::Event::Clip { text } => crate::clip::add_remote(text),
            _ => {}
        }
        let _ = app.emit("link-files", &e);
    })
}

/// 파일 채널 서버: 링크가 켜질 때 1번 시작 (Hera 수명 동안 유지). 꺼져 있는 동안 들어온 접속은 바로 닫는다.
/// ponytail: 포트 변경은 Hera 재시작 후 반영 — 자주 바꾸면 리스너 재생성으로
pub fn files_start(app: &AppHandle) {
    if !read_cfg(app).0 || FILES.set(()).is_err() {
        return;
    }
    let port = read_cfg(app).1.file_port;
    let listener = match std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)) {
        Ok(l) => l,
        Err(e) => {
            set(app, |s| s.detail = format!("파일 채널 포트 {port} 를 열 수 없어요: {e}"));
            return;
        }
    };
    let (a1, a2, a3) = (app.clone(), app.clone(), app.clone());
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cfg: Arc<dyn Fn() -> lf::Config + Send + Sync> = Arc::new(move || files_cfg(&a1));
    let on_conn: Arc<dyn Fn(Option<Arc<Conn>>) + Send + Sync> = Arc::new(move |c: Option<Arc<Conn>>| {
        let mut cur = CONN.lock().unwrap();
        if let (Some(old), Some(new)) = (cur.as_ref(), c.as_ref()) {
            if !Arc::ptr_eq(old, new) {
                old.close(); // 새 접속이 이전 연결을 대체
            }
        }
        if !read_cfg(&a2).0 {
            if let Some(c) = &c {
                c.close();
            }
            *cur = None;
            return;
        }
        *cur = c;
    });
    let s = sink(app);
    std::thread::spawn(move || lf::serve(listener, cfg, s, on_conn, stop));
    let name = read_cfg(app).1.me;
    std::thread::spawn(move || {
        let never = std::sync::atomic::AtomicBool::new(false);
        lf::beacon(&name, port, &never, &|| !read_cfg(&a3).0 || CONN.lock().unwrap().as_ref().is_some_and(|c| c.is_ready()));
    });
}

pub fn pair_confirm(ok: bool) {
    if let Some(c) = CONN.lock().unwrap().as_ref() {
        c.confirm(ok);
    }
}

pub fn unpair(app: &AppHandle) {
    if let Ok(s) = app.store("hera.json") {
        s.delete("link.peerPk");
        s.delete("link.peerName");
    }
    if let Some(c) = CONN.lock().unwrap().take() {
        c.close();
    }
}

/// 파일을 맥으로 (블로킹 — spawn_blocking 에서)
pub fn send_file(app: &AppHandle, path: &str) -> Result<(), String> {
    let c = CONN.lock().unwrap().clone().filter(|c| c.is_ready()).ok_or("맥과 연결되어 있지 않아요")?;
    c.send_file(Path::new(path), &sink(app))
}

/// 이 PC 클립보드 기록에 새 항목 → 맥 Hera 기록에도 (클립보드 자체는 엔진이 맞춘다)
pub fn on_local_clip(text: &str) {
    let Some(c) = CONN.lock().unwrap().clone().filter(|c| c.is_ready()) else { return };
    let t = text.to_string();
    std::thread::spawn(move || {
        let _ = c.send_clip(&t);
    });
}

pub fn files_connected() -> Option<String> {
    CONN.lock().unwrap().as_ref().filter(|c| c.is_ready()).map(|c| c.peer_name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(side: &str) -> Cfg {
        Cfg { me: "DEV-PC".into(), peer: "MacBook".into(), side: side.into(), port: 24900, tls: true, double_tap: false, file_port: 24810 }
    }

    #[test]
    fn config_generation() {
        let s = server_conf(&cfg("right"));
        assert_eq!(s, "section: screens\n\tDEV-PC:\n\tMacBook:\nend\n\nsection: links\n\tDEV-PC:\n\t\tright = MacBook\n\tMacBook:\n\t\tleft = DEV-PC\nend\n\nsection: options\nend\n");
        assert!(server_conf(&cfg("top")).contains("\t\tup = MacBook\n\tMacBook:\n\t\tdown = DEV-PC"));
        assert!(server_conf(&cfg("bottom")).contains("down = MacBook"));
        assert!(server_conf(&cfg("left")).contains("left = MacBook"));
        assert!(server_conf(&Cfg { double_tap: true, ..cfg("right") }).contains("\tswitchDoubleTap = 250\n"));
        let ini = settings_ini(&cfg("right"), Path::new(r"C:\x\server.conf"), Path::new(r"C:\x\settings\tls\deskflow.pem"));
        assert!(ini.contains("port=24900\n") && ini.contains("computerName=DEV-PC\n") && ini.contains("coreMode=2\n"));
        assert!(ini.contains("externalConfigFile=C:/x/server.conf\n") && ini.contains("certificate=C:/x/settings/tls/deskflow.pem\n"));
        assert!(ini.contains("tlsEnabled=true\n") && ini.contains("protocol=barrier\n"));
    }

    #[test]
    fn log_parsing() {
        let p = |s: &str| parse_line(s);
        assert_eq!(p(r#"[2026-11-15T12:03:00.851] INFO: switch from "DEV-PC" to "MacBook" at 1919,500"#), Some(LogEv::Switch { from: "DEV-PC".into(), to: "MacBook".into() }));
        assert_eq!(p(r#"[t] INFO: jump from "MacBook" to "DEV-PC" at 5,5"#), Some(LogEv::Switch { from: "MacBook".into(), to: "DEV-PC".into() }));
        assert_eq!(p("[t] INFO: accepted client connection"), Some(LogEv::Connected { name: String::new() }));
        assert_eq!(p(r#"[t] DEBUG: client "MacBook" has connected"#), Some(LogEv::Connected { name: "MacBook".into() }));
        assert_eq!(p(r#"[t] INFO: disconnecting client "MacBook""#), Some(LogEv::Disconnected { name: "MacBook".into() }));
        assert_eq!(p("[t] WARNING: fingerprint does not match trusted fingerprint"), Some(LogEv::Untrusted));
        assert_eq!(p("[t] INFO: peer fingerprint: SHA256:24:D2:CA"), Some(LogEv::Fingerprint { fp: "24d2ca".into() }));
        assert!(matches!(p("[t] FATAL: failed to create event for windows event loop"), Some(LogEv::Error { msg }) if msg.contains("Deskflow 앱을 먼저 종료")));
        assert!(matches!(p("[t] ERROR: tls certificate doesn't exist: C:/x.pem"), Some(LogEv::Error { msg }) if msg.contains("TLS 인증서")));
        assert_eq!(p("[t] INFO: local layouts: ko"), None);
        assert_eq!(p("[t] WARNING: failed to determine current keyboard layout"), None);
        assert_eq!(p("garbage"), None);
    }

    #[test]
    fn fingerprints_and_trust() {
        assert_eq!(norm_fp("v2:sha256:ABCD"), "abcd");
        assert_eq!(norm_fp("SHA256:AB:CD"), "abcd");
        let fp = "a".repeat(64);
        let once = trust_line("", &fp).unwrap();
        assert_eq!(once, format!("v2:sha256:{fp}\n"));
        assert_eq!(trust_line(&once, &fp.to_uppercase()), None); // 중복 없음
        assert_eq!(trust_line("v2:sha256:bb\n", &fp).unwrap(), format!("v2:sha256:bb\nv2:sha256:{fp}\n"));
        // PEM → DER SHA-256 (DER = "hi" → sha256("hi"))
        let pem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n-----BEGIN CERTIFICATE-----\naGk=\n-----END CERTIFICATE-----\n";
        assert_eq!(cert_fp(pem).unwrap(), "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4");
    }

    #[test]
    fn deskflow_import() {
        let ini = "[core]\ncomputerName=DEV-KIM\nport=24800\n[server]\nenableSwitchDoubleTap=true\n[security]\n";
        let conf = "section: links\n\tDEV-KIM:\n\t\tright = MacBook\n\tMacBook:\n\t\tleft = DEV-KIM\nend\n";
        let c = parse_deskflow(ini, conf);
        assert_eq!((c.me.as_str(), c.peer.as_str(), c.side.as_str(), c.port, c.double_tap, c.tls), ("DEV-KIM", "MacBook", "right", 24800, true, true));
        let c = parse_deskflow(ini, "section: links\n\tDEV-KIM:\n\t\tup(0,50) = Mac(50,100)\nend\n");
        assert_eq!((c.side.as_str(), c.peer.as_str()), ("top", "Mac"));
    }
}
