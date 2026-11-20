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
    /// 키 매핑: habit(윈도우 습관대로) / position(키 위치대로, 엔진 기본) / shortcuts(단축키만 — 맥 Hera 가 처리) / custom
    pub keymap: String,
    /// custom: (윈도우 수식키, 맥 수식키) — shift/ctrl/alt/altgr/meta/super, 맥 쪽은 none 도
    pub key_rows: Vec<(String, String)>,
    /// 한/영: hera(맥 Hera 가 입력 소스 전환) / capslock / ctrl-space / cmd-space / fn (엔진으로 단축키 보내기, 실험적)
    pub ime: String,
    /// 이 PC 의 역할: main = 이 PC 마우스·키보드로 다른 기기를 움직임(엔진 서버) · sub = 다른 PC(중심)가 이 PC 를 움직임(엔진 클라이언트)
    pub role: String,
    /// sub: 중심 PC 주소 (비우면 같은 네트워크에서 자동으로 찾음)
    pub server: String,
    /// 클립보드 공유 (store `link.share.clip`, 저장은 따로 — 바뀌면 엔진을 다시 띄운다)
    #[serde(skip)]
    pub clip: bool,
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
            keymap: "habit".into(),
            key_rows: vec![],
            ime: "hera".into(),
            role: "main".into(),
            server: String::new(),
            clip: true,
        }
    }
}

/// 엔진 서버 설정 파일. 1.27 은 이름을 설정 INI 의 [computer_*] 에서 읽고 screens 섹션은 무시, options 는 keystroke/mousepress 만 →
/// links(가장자리 범위) + 빈 options. 수식키·두 번 치기는 INI 로.
pub fn server_conf(c: &Cfg, devs: &[(String, String)], segs: &[crate::link_layout::Seg]) -> String {
    crate::link_layout::links_section(&c.me, devs, segs, &c.side) + "\nsection: options\nend\n"
}

const MODS: [&str; 6] = ["shift", "ctrl", "alt", "altgr", "meta", "super"];

/// 맥(엔진 클라이언트) 쪽 수식키 매핑: 윈도우 키 → 맥에서 그 키로 (엔진 [computer_<맥>] modifier* 키)
pub fn modifiers(c: &Cfg) -> Vec<(&'static str, String)> {
    let mut m: Vec<(&'static str, String)> = MODS.iter().map(|k| (*k, k.to_string())).collect();
    let set = |m: &mut Vec<(&'static str, String)>, from: &str, to: &str| {
        if let Some(e) = m.iter_mut().find(|(k, _)| *k == from) {
            e.1 = to.to_string();
        }
    };
    match c.keymap.as_str() {
        // Ctrl → ⌘, Win → Ctrl : 윈도우에서 하던 Ctrl+C/V/Z 가 맥에서 그대로
        "habit" => (set(&mut m, "ctrl", "super"), set(&mut m, "super", "ctrl")).1,
        "custom" => {
            for (from, to) in &c.key_rows {
                if MODS.contains(&from.as_str()) && (MODS.contains(&to.as_str()) || to == "none") {
                    set(&mut m, from, to);
                }
            }
        }
        _ => {} // position · shortcuts(맥 Hera 가 Ctrl+C 등만 ⌘ 로) = 엔진 기본
    }
    m
}

fn mod_key(k: &str) -> &'static str {
    match k {
        "shift" => "modifierShift",
        "ctrl" => "modifierCtrl",
        "alt" => "modifierAlt",
        "altgr" => "modifierAltGr",
        "meta" => "modifierMeta",
        _ => "modifierSuper",
    }
}

/// 엔진 설정 INI (portable: exe 옆 settings\Deskflow.conf)
/// devs = (엔진 이름, 맥인가) — 맥에만 수식키 매핑 (윈도우끼리는 그대로)
pub fn settings_ini(c: &Cfg, devs: &[(String, bool)], conf: &Path, cert: &Path) -> String {
    let p = |x: &Path| x.display().to_string().replace('\\', "/");
    format!(
        "[core]\ncomputerName={me}\nport={port}\ncoreMode=2\npreventSleep=false\n\n[server]\nexternalConfig=true\nexternalConfigFile={conf}\nprotocol=barrier\nenableClipboard={clip}\nclipboardSize=3\nenableSwitchDoubleTap={dt}\nswitchDoubleTap=250\n\n[security]\ntlsEnabled={tls}\ncheckPeerFingerprints=true\ncertificate={cert}\n\n[log]\nlevel=INFO\n\n[computer_{me}]\nname={me}\n{others}",
        me = c.me,
        port = c.port,
        conf = p(conf),
        dt = c.double_tap,
        tls = c.tls,
        clip = c.clip,
        cert = p(cert),
        others = devs
            .iter()
            .map(|(n, mac)| format!("\n[computer_{n}]\nname={n}\n{}", if *mac { modifiers(c).iter().map(|(k, v)| format!("{}={v}\n", mod_key(k))).collect::<String>() } else { String::new() }))
            .collect::<String>()
    )
}

/// 받는 쪽(sub) 엔진 INI: 클라이언트 모드, 중심 PC 주소. 중심 PC 인증서 지문은 settings\tls\trusted-servers 로 믿는다
pub fn client_ini(c: &Cfg, host: &str, cert: &Path) -> String {
    let p = cert.display().to_string().replace('\\', "/");
    format!(
        "[core]\ncomputerName={me}\nport={port}\ncoreMode=1\npreventSleep=false\n\n[client]\nremoteHost={host}\n\n[security]\ntlsEnabled={tls}\ncheckPeerFingerprints=true\ncertificate={p}\n\n[log]\nlevel=INFO\n",
        me = c.me,
        port = c.port,
        tls = c.tls
    )
}

#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LogEv {
    Connected { name: String },
    Disconnected { name: String },
    /// at = 로그의 "at x,y" (들어간 화면의 좌표)
    Switch { from: String, to: String, at: Option<(i32, i32)> },
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
        let at = msg.rsplit_once(" at ").and_then(|(_, xy)| xy.trim().split_once(',')).and_then(|(x, y)| Some((x.trim().parse().ok()?, y.trim().parse().ok()?)));
        return Some(LogEv::Switch { from: quoted(msg, 0), to: quoted(msg, 1), at });
    }
    // 받는 쪽(클라이언트) 엔진
    if has("connected to server") && !has("failed") {
        return Some(LogEv::Connected { name: String::new() });
    }
    if has("disconnected from server") {
        return Some(LogEv::Disconnected { name: String::new() });
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
            "암호화 인증서가 없어요 — 'Deskflow 설정 가져오기'로 가져오거나 연결 암호화를 끄세요".to_string()
        } else if msg.contains("failed to create event for windows event loop") {
            "다른 Deskflow가 실행 중이에요 — Deskflow 앱을 먼저 종료하세요".to_string()
        } else if msg.contains("listen") || msg.contains("bind") || msg.contains("address already in use") {
            format!("포트를 열 수 없어요 — 다른 프로그램이 쓰고 있을 수 있어요 ({msg})")
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
    crate::tray::set_connected(app, s.state == "connected");
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
    c.clip = shared(app, "clip");
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

/* ── 모니터별 배치 (link_layout) ── */
use crate::link_layout::{self as ll, Mon};

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct MacMon {
    pub id: String,
    pub rect: [f64; 4],
}

/// store `link.layout` = { at: { 모니터 id: [x, y] (캔버스) } }
#[derive(Deserialize, Default)]
struct LayoutStore {
    #[serde(default)]
    at: std::collections::HashMap<String, [f64; 2]>,
}

/// 이어진 기기 (맥 · 다른 윈도우 노트북 …). store `link.devices`.
/// id = 파일 채널 공개키 hex (짝을 맞추기 전 맥 자리 표시는 "mac"), name = 엔진 화면 이름, os = "mac" | "win", mons = 그 기기가 보고한 모니터
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Dev {
    pub id: String,
    pub name: String,
    pub os: String,
    #[serde(default)]
    pub mons: Vec<MacMon>,
}

/// 기기 목록. 없으면 예전 한 대(맥) 설정에서 만든다 (link.peerPk · link.macMonitors · 맥 이름)
pub fn devices(app: &AppHandle) -> Vec<Dev> {
    let Ok(s) = app.store("hera.json") else { return vec![] };
    if let Some(v) = s.get("link.devices").and_then(|v| serde_json::from_value::<Vec<Dev>>(v).ok()) {
        return v;
    }
    let id = s.get("link.peerPk").and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "mac".into());
    let mons = s.get("link.macMonitors").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    vec![Dev { id, name: read_cfg(app).1.peer, os: "mac".into(), mons }]
}

pub fn save_devices(app: &AppHandle, devs: &[Dev]) {
    if let Ok(s) = app.store("hera.json") {
        s.set("link.devices", serde_json::to_value(devs).unwrap_or(Value::Null));
    }
    let _ = app.emit("link-devices", ());
}

/// 모니터를 아직 모를 때의 자리 표시 (맥 2대 · 노트북 1대 — 설정 캔버스에서 위치만 맞추면 된다)
pub fn placeholder(os: &str) -> Vec<MacMon> {
    if os == "mac" {
        vec![MacMon { id: "Mac 1".into(), rect: [0.0, 0.0, 1512.0, 982.0] }, MacMon { id: "Mac 2".into(), rect: [1512.0, 0.0, 1920.0, 1080.0] }]
    } else {
        vec![MacMon { id: "1".into(), rect: [0.0, 0.0, 1920.0, 1080.0] }]
    }
}

/// 캔버스 모니터 id: 맥은 예전 그대로(저장된 위치 유지), 윈도우 기기는 "<이름>:<모니터>"
pub fn mon_id(d: &Dev, m: &str) -> String {
    if d.os == "mac" {
        m.to_string()
    } else {
        format!("{}:{m}", d.name)
    }
}

/// 캔버스 위 모든 모니터. PC 모니터는 Windows 배치 그대로(주 모니터 배율로 나눔 — 맞닿음 유지),
/// 기기 모니터는 저장 위치 또는 기본(첫 기기 = 설정한 방향, 그다음 오른쪽 · 왼쪽 · 위 · 아래 중 남은 쪽)
pub fn layout(app: &AppHandle) -> Vec<Mon> {
    let wins = crate::watch::monitors();
    let s = wins.iter().find(|m| m.3).or(wins.first()).map_or(1.0, |m| m.2).max(0.5);
    let mut mons: Vec<Mon> = wins.iter().map(|(id, r, _, _)| Mon { id: id.clone(), mac: false, dev: String::new(), rect: *r, at: [r[0] / s, r[1] / s, r[2] / s, r[3] / s] }).collect();
    let store: LayoutStore = app.store("hera.json").ok().and_then(|st| st.get("link.layout")).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let (wl, wt, wr, wb) = mons.iter().fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |a, m| (a.0.min(m.at[0]), a.1.min(m.at[1]), a.2.max(m.at[0] + m.at[2]), a.3.max(m.at[1] + m.at[3])));
    let first = read_cfg(app).1.side;
    let order: Vec<&str> = std::iter::once(first.as_str()).chain(["right", "left", "top", "bottom"].into_iter().filter(|x| *x != first)).collect();
    for (i, d) in devices(app).iter().enumerate() {
        let ms = if d.mons.is_empty() { placeholder(&d.os) } else { d.mons.clone() };
        let (ml, mt) = ms.iter().fold((f64::MAX, f64::MAX), |a, m| (a.0.min(m.rect[0]), a.1.min(m.rect[1])));
        let (mw, mh) = ms.iter().fold((0.0f64, 0.0f64), |a, m| (a.0.max(m.rect[0] + m.rect[2] - ml), a.1.max(m.rect[1] + m.rect[3] - mt)));
        // 기본 위치: 기기 배치를 통째로 PC 경계 상자의 그 방향에 붙임 (다섯째부터는 오른쪽에 이어서)
        let (ox, oy) = match order.get(i).copied().unwrap_or("right") {
            "left" => (wl - mw, wt),
            "top" => (wl, wt - mh),
            "bottom" => (wl, wb),
            _ => (wr + if i >= 4 { (i - 3) as f64 * 2000.0 } else { 0.0 }, wt),
        };
        for m in ms {
            let id = mon_id(d, &m.id);
            let def = [ox + m.rect[0] - ml, oy + m.rect[1] - mt];
            let [x, y] = store.at.get(&id).copied().unwrap_or(def);
            mons.push(Mon { id, mac: true, dev: d.id.clone(), rect: m.rect, at: [x, y, m.rect[2], m.rect[3]] });
        }
    }
    mons
}

pub fn plan(app: &AppHandle) -> (Vec<Mon>, ll::Plan) {
    let mons = layout(app);
    let p = ll::plan(&mons);
    (mons, p)
}

/// TLS 인증서가 없을 때: 자체 서명 (ECDSA P-256, rcgen) — 'Deskflow 설정 가져오기' 없이도 새로 시작 가능.
/// ponytail: Deskflow GUI 는 RSA 를 만들지만 엔진(OpenSSL)은 EC 인증서도 쓴다 — 맥 쪽에서 문제가 보이면 RSA 로
pub fn ensure_cert(path: &Path, name: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let mut params = rcgen::CertificateParams::new(vec![name.to_string()]).map_err(|e| e.to_string())?;
    params.distinguished_name.push(rcgen::DnType::CommonName, name);
    params.not_after = rcgen::date_time_ymd(2046, 1, 1);
    let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
    std::fs::write(path, format!("{}{}", key.serialize_pem(), cert.pem())).map_err(|e| e.to_string())
}

/// 엔진 설정 두 파일의 내용 (기기 · 배치가 바뀌면 달라진다 → 감독 스레드가 엔진을 다시 띄운다)
fn engine_files(app: &AppHandle, c: &Cfg, conf: &Path, cert: &Path) -> (String, String) {
    let devs = devices(app);
    let names: Vec<(String, String)> = devs.iter().map(|d| (d.id.clone(), engine_name(c, d))).collect();
    let kinds: Vec<(String, bool)> = devs.iter().map(|d| (engine_name(c, d), d.os == "mac")).collect();
    (server_conf(c, &names, &plan(app).1.segs), settings_ini(c, &kinds, conf, cert))
}

/// 엔진 화면 이름: 맥 = 설정의 맥 이름(맥 Hera 가 그 이름으로 엔진을 띄운다), 윈도우 기기 = 그 PC 가 알려 준 이름
pub fn engine_name(c: &Cfg, d: &Dev) -> String {
    if d.os == "mac" {
        c.peer.clone()
    } else {
        d.name.clone()
    }
}

/// 받는 쪽: 중심 PC 주소 (설정에 적은 것 > 파일 채널로 찾은 것)
pub fn server_host(app: &AppHandle, c: &Cfg) -> Option<String> {
    let typed = c.server.trim().split(':').next().unwrap_or("").to_string();
    if !typed.is_empty() {
        return Some(typed);
    }
    app.store("hera.json").ok().and_then(|s| s.get("link.serverAddr")).and_then(|v| v.as_str().map(String::from)).filter(|s| !s.is_empty())
}

/// 받는 쪽 엔진 준비: 엔진 파일 · 내 인증서 · 클라이언트 INI (중심 PC 지문은 짝 맞출 때 trusted-servers 에)
fn prepare_client(app: &AppHandle, c: &Cfg) -> Result<PathBuf, String> {
    let d = engine_dir(app).ok_or("앱 데이터 폴더 없음")?;
    install(app, &d)?;
    let tls = d.join("settings").join("tls");
    std::fs::create_dir_all(&tls).map_err(|e| e.to_string())?;
    let cert = tls.join("deskflow.pem");
    if c.tls {
        ensure_cert(&cert, &c.me).map_err(|e| format!("암호화 인증서를 만들지 못했어요: {e}"))?;
    }
    let host = server_host(app, c).ok_or("중심 PC 주소가 없어요")?;
    std::fs::write(d.join("settings").join("Deskflow.conf"), client_ini(c, &host, &cert)).map_err(|e| e.to_string())?;
    Ok(d)
}

/// 받는 쪽: 중심 PC 엔진 지문 신뢰 (짝 맞출 때 파일 채널로 받은 값)
fn trust_server(app: &AppHandle, fp: &str) {
    let Some(f) = engine_dir(app).map(|d| d.join("settings").join("tls").join("trusted-servers")) else { return };
    let _ = std::fs::create_dir_all(f.parent().unwrap());
    let cur = std::fs::read_to_string(&f).unwrap_or_default();
    if let Some(next) = trust_line(&cur, fp) {
        let _ = std::fs::write(&f, next);
    }
}

/// 감독 스레드 비교용: 설정 + 엔진 두 파일 내용
fn engine_key(app: &AppHandle, c: &Cfg) -> String {
    if c.role == "sub" {
        return format!("{c:?}\n{:?}", server_host(app, c));
    }
    let d = engine_dir(app).unwrap_or_default();
    let (a, b) = engine_files(app, c, &d.join("server.conf"), &d.join("settings").join("tls").join("deskflow.pem"));
    format!("{c:?}\n{a}\n{b}")
}

fn prepare(app: &AppHandle, c: &Cfg) -> Result<PathBuf, String> {
    let d = engine_dir(app).ok_or("앱 데이터 폴더 없음")?;
    install(app, &d)?;
    let (conf, tls) = (d.join("server.conf"), d.join("settings").join("tls"));
    std::fs::create_dir_all(&tls).map_err(|e| e.to_string())?;
    let cert = tls.join("deskflow.pem");
    if c.tls {
        ensure_cert(&cert, &c.me).map_err(|e| format!("암호화 인증서를 만들지 못했어요: {e}"))?;
    }
    let (conf_text, ini_text) = engine_files(app, c, &conf, &cert);
    std::fs::write(&conf, conf_text).map_err(|e| e.to_string())?;
    std::fs::write(d.join("settings").join("Deskflow.conf"), ini_text).map_err(|e| e.to_string())?;
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

fn spawn(app: &AppHandle, d: &Path, mode: &str) -> Result<Child, String> {
    let mut cmd = Command::new(d.join("deskflow-core.exe"));
    cmd.args([mode, "--new-instance"]).current_dir(d).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
        LogEv::Connected { name } => {
            let was = status().state == "connected";
            set(app, |s| (s.state = "connected".into(), s.peer = if name.is_empty() { s.peer.clone() } else { name.clone() }, s.detail.clear()).2);
            if !was {
                let st = status();
                crate::tray::toast(app, "link", &format!("{} 연결됨", st.peer), "가장자리로 마우스를 밀면 넘어가요");
            }
        }
        LogEv::Disconnected { .. } => {
            let was = status();
            set(app, |s| (s.state = "waiting".into(), s.on_peer = false).1);
            if was.state == "connected" {
                crate::tray::toast(app, "link", &format!("{} 연결 끊김", was.peer), "다시 켜지면 자동으로 이어져요");
            }
        }
        LogEv::Switch { to, at, .. } => {
            let on_peer = *to != me;
            set(app, |s| (s.on_peer = on_peer, s.state = "connected".into()).1);
            let _ = app.emit("link-switch", json!({ "to": to, "onPeer": on_peer }));
            crossing(app, on_peer, *at);
        }
        LogEv::Fingerprint { fp } => STATUS.lock().unwrap().fingerprint = fp.clone(),
        LogEv::Untrusted => {
            let fp = STATUS.lock().unwrap().fingerprint.clone();
            set(app, |s| (s.detail = "처음 보는 맥이 연결하려 해요 — 설정 → 연결에서 지문을 확인하고 신뢰를 눌러 주세요".into(), s.fingerprint = fp).1);
        }
        LogEv::Error { msg } => set(app, |s| (s.state = "error".into(), s.detail = msg.clone()).1),
    }
}

/* ── 넘어감: 파란 물결(스위치 `ripple.enabled`) · crossed 알림 · 한/영 가로채기 ── */

/// 이 PC 경계 상자 [l, t, r, b] (물리 px)
fn desk_bbox() -> [f64; 4] {
    crate::watch::monitors().iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, (_, r, _, _)| [b[0].min(r[0]), b[1].min(r[1]), b[2].max(r[0] + r[2]), b[3].max(r[1] + r[3])])
}

static ONCE: Mutex<crate::crossing::Debounce> = Mutex::new(crate::crossing::Debounce(None));

/// 넘어감 물결 + 벽 일렁임 (한 넘어감에 한 번). on_peer = 맥으로 떠남, at = 들어온 자리(이 PC 좌표, 있으면)
#[cfg(windows)]
fn crossing_fx(app: &AppHandle, side: &str, on_peer: bool, at: Option<(i32, i32)>) {
    use crate::crossing::{leave_point, wall_for, Side};
    if !crate::flag(app, "ripple.enabled", true) || !ONCE.lock().unwrap().accept(on_peer, crate::watch::now_ms()) {
        return;
    }
    let mons: Vec<([i32; 4], f64)> = crate::watch::monitors().iter().map(|(_, r, s, _)| ([r[0] as i32, r[1] as i32, r[2] as i32, r[3] as i32], *s)).collect();
    let b = desk_bbox();
    let bb = [b[0] as i32, b[1] as i32, b[2] as i32, b[3] as i32];
    let side = match at {
        Some((x, y)) => Side::parse(ll::nearest_side(b, x as f64, y as f64)),
        None => Side::parse(side),
    }
    .unwrap_or(Side::Right);
    // 떠날 때는 '지금 커서'가 아니라 넘어가기 직전 표본 (엔진이 커서를 가운데로 옮겨 숨긴다)
    let (x, y) = at.unwrap_or_else(|| leave_point(side, &crate::watch::cursor_samples(), crate::watch::now_ms(), bb));
    let kind = if on_peer { crate::ripple::Kind::Leave } else { crate::ripple::Kind::Enter };
    crate::ripple::show_crossing(x, y, side.name(), kind, wall_for(side, (x, y), &mons));
}

fn crossing(app: &AppHandle, on_peer: bool, at: Option<(i32, i32)>) {
    let cfg = read_cfg(app).1;
    if on_peer {
        // 떠남: 이 PC 의 벽에 옅은 물결 + 일렁임 (at = 맥 좌표라 쓰지 않는다), 맥에는 들어간 좌표로 진한 물결을 그리게
        #[cfg(windows)]
        {
            crossing_fx(app, &cfg.side, true, None);
            if cfg.ime != "off" {
                crate::shell::ime_forward(true);
            }
        }
        send(json!({ "t": "crossed", "enter": true, "x": at.map(|a| a.0), "y": at.map(|a| a.1) }));
    } else {
        #[cfg(windows)]
        {
            crate::shell::ime_forward(false);
            crossing_fx(app, &cfg.side, false, at);
        }
        send(json!({ "t": "crossed", "enter": false }));
    }
    let _ = cfg;
}

/// 파일 채널로 제어 메시지 — 이어진 기기 모두에게 (연결 없으면 조용히 무시)
pub fn send(v: Value) {
    for c in ready() {
        let v = v.clone();
        std::thread::spawn(move || {
            let _ = c.send(v);
        });
    }
}

/// 한 기기에게
pub fn send_to(pk: &str, v: Value) {
    if let Some(c) = ready().into_iter().find(|c| c.peer_pk == pk) {
        std::thread::spawn(move || {
            let _ = c.send(v);
        });
    }
}

/// 접속 직후: 내 모니터 · 키 매핑 (그 기기에게)
fn hello_after_ready(app: &AppHandle, pk: &str) {
    let mons: Vec<Value> = crate::watch::monitors().into_iter().map(|(id, r, s, p)| json!({ "id": id, "rect": r, "scale": s, "primary": p })).collect();
    send_to(pk, json!({ "t": "monitors", "list": mons }));
    let c = read_cfg(app).1;
    send_to(pk, json!({ "t": "keymap", "preset": c.keymap, "rows": c.key_rows, "ime": c.ime }));
}

/// 기기(pk)에서 온 제어 메시지
fn on_msg(app: &AppHandle, pk: &str, m: &Value) {
    match m["t"].as_str().unwrap_or("") {
        "monitors" => {
            let list: Vec<MacMon> = m["list"].as_array().into_iter().flatten().filter_map(|x| Some(MacMon { id: x["id"].as_str()?.to_string(), rect: serde_json::from_value(x["rect"].clone()).ok()? })).collect();
            let mut devs = devices(app);
            if let Some(d) = devs.iter_mut().find(|d| d.id == pk).filter(|d| !list.is_empty() && d.mons != list) {
                d.mons = list;
                save_devices(app, &devs);
                apply(); // 엔진 링크 다시 생성
                update_edges(app);
            }
            let _ = app.emit("link-monitors", ());
        }
        "crossed" => {
            // 맥이 서버일 때(미래) 대비: 들어옴/나감 물결
            // 같은 넘어감을 이 PC 로그로 이미 그렸으면 Debounce 가 버린다
            #[cfg(windows)]
            if let (Some(x), Some(y)) = (m["x"].as_i64(), m["y"].as_i64()) {
                crossing_fx(app, &read_cfg(app).1.side, m["enter"] != true, Some((x as i32, y as i32)));
            }
        }
        // 전체 톡 (맥도 같은 방)
        "talk" | "poke" => {
            let d = devices(app).into_iter().find(|d| d.id == pk);
            let from = if d.as_ref().is_none_or(|d| d.os == "mac") { "mac".to_string() } else { pk.to_string() };
            let name = d.map(|d| d.name).or_else(|| ready().into_iter().find(|c| c.peer_pk == pk).map(|c| c.peer_name.clone())).unwrap_or_else(|| "내 맥".into());
            crate::talk::received(app, &from, &name, m)
        }
        _ => {}
    }
}

/// 연결된 가장자리 구간에 끌어 놓기 띠 (파일 채널이 준비됐을 때만)
pub fn update_edges(app: &AppHandle) {
    #[cfg(windows)]
    {
        let on: Vec<String> = ready().iter().map(|c| c.peer_pk.clone()).collect();
        let segs: Vec<_> = plan(app).1.segs.into_iter().filter(|g| on.contains(&g.dev)).map(|g| (g.side, g.edge, g.mac)).collect();
        crate::drag::set_segs(segs.iter().map(|(s, e, _)| (s.clone(), *e)).collect());
        crate::edge::set(segs);
    }
    let _ = app;
}

/// 가장자리 띠에 놓은 파일 → 맥으로 (via edge) + 그 자리에 물결
#[cfg(windows)]
fn edge_drop(app: &AppHandle, files: Vec<String>, mac_side: String, pos: f64, pt: (i32, i32)) {
    // 포탈이 보이면 빨려 들어가는 애니메이션 뒤 JS 가 보낸다 (link_send + edge/pos)
    if crate::drag::portal_drop(app, &files, &mac_side, pos, pt) {
        return;
    }
    let side = ll::nearest_side(desk_bbox(), pt.0 as f64, pt.1 as f64);
    crate::ripple::show(pt.0, pt.1, Some(side), crate::ripple::Kind::Leave);
    // 그 가장자리 구간의 기기
    let dev = plan(app).1.segs.into_iter().filter(|g| ll::opposite_side(&g.side) == mac_side).min_by_key(|g| {
        let e = g.edge;
        let (cx, cy) = (e[0] + e[2] / 2.0, e[1] + e[3] / 2.0);
        ((cx - pt.0 as f64).abs() + (cy - pt.1 as f64).abs()) as i64
    }).map(|g| g.dev);
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(c) = ready().into_iter().find(|c| dev.as_ref().is_none_or(|d| *d == c.peer_pk)) else { return };
        for f in files {
            let _ = c.send_file_meta(Path::new(&f), &sink(&app), json!({ "via": "edge", "edge": mac_side, "pos": pos }));
        }
    });
}

/// 함께 쓰기 스위치: store `link.share.<k>` (없으면 켬). 지금은 clip(클립보드 공유)만
pub fn shared(app: &AppHandle, k: &str) -> bool {
    app.store("hera.json").ok().and_then(|s| s.get("link.share")).and_then(|v| v.get(k).and_then(|b| b.as_bool())).unwrap_or(true)
}

/// 감독 스레드: 켜짐 → (충돌 검사) → 준비 → 실행 → 죽으면 백오프 재시작. 꺼짐/설정 변경 → 우리 자식만 종료.
pub fn start(app: AppHandle) {
    let (tx, rx) = channel::<()>();
    let _ = CTL.set(tx);
    #[cfg(windows)]
    {
        let a = app.clone();
        crate::shell::on_hangul(move || {
            // 맥에 커서가 있을 때 한/영: 맥 Hera 가 입력 소스 전환 (또는 엔진으로 맥 전환 단축키 — 실험적)
            let c = read_cfg(&a).1;
            match c.ime.as_str() {
                "hera" if files_connected().is_some() => send(json!({ "t": "ime", "action": "toggle" })),
                // 맥 Hera 가 없다(맥은 Deskflow 만) → 맥 기본 입력 전환 단축키 ^Space 를 엔진으로
                "hera" => send_switch_shortcut("ctrl-space", &c),
                m => send_switch_shortcut(m, &c),
            }
        });
        let a = app.clone();
        crate::edge::on_drop(move |files, side, pos, pt| edge_drop(&a, files, side, pos, pt));
    }
    std::thread::spawn(move || {
        // 엔진 설정 내용(기기 · 배치 포함)이 바뀌면 다시 띄운다
        let mut child: Option<(Child, String, Instant)> = None;
        let mut backoff = 1u64;
        loop {
            let (on, cfg) = read_cfg(&app);
            let key = engine_key(&app, &cfg);
            let changed = child.as_ref().is_some_and(|(_, k, _)| *k != key);
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
                    set(&app, |s| (s.state = "blocked".into(), s.detail = "Deskflow 앱(deskflow-core)이 실행 중이에요 — Deskflow를 먼저 종료하세요".into()).1);
                    if matches!(rx.recv_timeout(Duration::from_secs(5)), Err(RecvTimeoutError::Disconnected)) {
                        return;
                    }
                    continue;
                }
                let sub = cfg.role == "sub";
                if sub && server_host(&app, &cfg).is_none() {
                    set(&app, |s| (s.state = "waiting".into(), s.detail = "중심 PC를 찾는 중이에요 — 같은 네트워크에서 Hera 연결이 켜져 있어야 해요".into()).1);
                    if matches!(rx.recv_timeout(Duration::from_secs(3)), Err(RecvTimeoutError::Disconnected)) {
                        return;
                    }
                    continue;
                }
                let made = if sub { prepare_client(&app, &cfg).and_then(|d| spawn(&app, &d, "client")) } else { prepare(&app, &cfg).and_then(|d| spawn(&app, &d, "server")) };
                match made {
                    Ok(c) => {
                        set(&app, |s| (s.state = "waiting".into(), s.detail.clear()).1);
                        child = Some((c, key, Instant::now()));
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

/// 이어진 기기들의 파일 채널 (기기마다 하나 — 같은 기기가 다시 붙으면 예전 것을 닫는다)
static CONNS: Mutex<Vec<Arc<Conn>>> = Mutex::new(Vec::new());
/// 숫자 확인을 기다리는 새 기기 연결 (한 번에 하나)
static PAIRING: Mutex<Option<Arc<Conn>>> = Mutex::new(None);
static FILES: OnceLock<()> = OnceLock::new();

/// 준비된 연결들
pub fn ready() -> Vec<Arc<Conn>> {
    CONNS.lock().unwrap().iter().filter(|c| c.is_ready()).cloned().collect()
}

/// 이어진 기기 (pk, 이름, os) — 패널 · 보낼 곳 목록
pub fn connected(app: &AppHandle) -> Vec<(String, String, String)> {
    let devs = devices(app);
    ready()
        .iter()
        .map(|c| {
            let d = devs.iter().find(|d| d.id == c.peer_pk);
            (c.peer_pk.clone(), d.map_or(c.peer_name.clone(), |d| if d.os == "mac" { c.peer_name.clone() } else { d.name.clone() }), d.map_or("mac".into(), |d| d.os.clone()))
        })
        .collect()
}

pub(crate) fn files_cfg(app: &AppHandle) -> lf::Config {
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
        // 여러 기기: 짝을 맞춘 기기들의 키 (받는 쪽이면 중심 PC 키)
        known: devices(app).iter().filter_map(|d| lf::unhex32(&d.id)).chain(get("link.serverPk").and_then(|k| lf::unhex32(&k))).collect(),
        engine_fp: my_fp(app),
        downloads: app.path().download_dir().unwrap_or_else(|_| std::env::temp_dir()).join("Hera"),
        accept_any: false,
    }
}

/// 보내는 파일 이름 (전송 id → 이름) — '보냈어요' 알림에 쓴다
static OUT_NAMES: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());

/// 연결 하나의 이벤트 처리 (pk = 그 연결의 상대 — Peer 이벤트로 안다)
fn sink(app: &AppHandle) -> lf::Sink {
    let app = app.clone();
    let me = Arc::new(Mutex::new(String::new()));
    Arc::new(move |e: lf::Event| {
        if let lf::Event::Peer { pk, .. } = &e {
            *me.lock().unwrap() = pk.clone();
        }
        let pk = me.lock().unwrap().clone();
        match &e {
            lf::Event::Peer { state, name, code, .. } if state == "pairing" => {
                crate::tray::toast(&app, "pair", &format!("{name} 연결 확인"), &format!("숫자 {} {} · 눌러서 확인", &code[..code.len().min(3)], &code[code.len().min(3)..]));
            }
            lf::Event::Xfer { dir, id, name, .. } if dir == "out" => {
                let mut n = OUT_NAMES.lock().unwrap();
                if !n.iter().any(|(i, _)| i == id) {
                    n.push((*id, name.clone()));
                }
            }
            lf::Event::Sent { id, ok, error } => {
                let name = {
                    let mut n = OUT_NAMES.lock().unwrap();
                    n.iter().position(|(i, _)| i == id).map(|i| n.remove(i).1).unwrap_or_default()
                };
                if *ok {
                    let _ = app.emit_to("pet", "pet-react", "sent");
                    crate::tray::toast(&app, "sent", "맥으로 보냈어요", &format!(r"{name} · 맥 다운로드\Hera"));
                } else {
                    crate::tray::toast(&app, "fail", "보내지 못했어요", error);
                }
            }
            lf::Event::Paired { pk, name, fp, .. } if read_cfg(&app).1.role == "sub" => {
                // 받는 쪽: 중심 PC 를 기억하고 그 엔진 지문을 믿는다
                if let Ok(s) = app.store("hera.json") {
                    s.set("link.serverPk", pk.clone());
                    s.set("link.serverName", name.clone());
                }
                if !fp.is_empty() {
                    trust_server(&app, fp);
                }
                apply();
            }
            lf::Event::Paired { pk, name, fp, os } => {
                // 기기 목록에 더한다: 맥은 자리 표시("mac")를 이 맥으로, 윈도우는 새 기기로 (같은 키면 갱신)
                let mut devs = devices(&app);
                devs.retain(|d| d.id != *pk && !(os == "mac" && d.id == "mac"));
                devs.push(Dev { id: pk.clone(), name: name.clone(), os: os.clone(), mons: vec![] });
                save_devices(&app, &devs);
                if let Ok(s) = app.store("hera.json") {
                    if os == "mac" {
                        s.set("link.peerPk", pk.clone());
                        s.set("link.peerName", name.clone());
                    }
                }
                apply(); // 새 화면 → 엔진 설정 다시
                // 맥 엔진(클라이언트)의 TLS 지문도 함께 신뢰 → 엔진 첫 연결에서 따로 묻지 않음
                if !fp.is_empty() {
                    let _ = trust(&app, fp);
                }
            }
            lf::Event::Received { path, meta, .. } => {
                crate::shelve(&app, std::slice::from_ref(path), "mac"); // 받은 파일 → 선반 (다운로드\Hera 에도 있음)
                let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let _ = app.emit_to("pet", "pet-react", "recv");
                // 받는 포탈 (시안 recv-portal): 맥 가장자리로 보냈으면 이어진 PC 가장자리 그 자리, 아니면 트레이 아이콘 위.
                // 파일이 트레이 아이콘으로 들어간 뒤 알림 카드. 전체화면 앱 중이면 애니메이션 없이 (알림도 tray::toast 가 거른다).
                #[cfg(windows)]
                let shown = !crate::watch::FULLSCREEN.load(std::sync::atomic::Ordering::Relaxed) && {
                    let edge = (meta["via"] == "edge")
                        .then(|| meta["edge"].as_str().zip(meta["pos"].as_f64()))
                        .flatten()
                        .and_then(|(side, pos)| ll::mac_to_win(&plan(&app).1.segs.into_iter().filter(|g| g.dev == pk).collect::<Vec<_>>(), side, pos));
                    crate::drag::recv_portal(&app, edge, &name)
                };
                #[cfg(not(windows))]
                let shown = false;
                let _ = meta;
                let sub = format!(r"{name} · 선반과 다운로드\Hera에 있어요");
                if shown {
                    let a = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1900));
                        crate::tray::toast(&a, "recv", "맥에서 파일을 받았어요", &sub);
                    });
                } else {
                    crate::tray::toast(&app, "recv", "맥에서 파일을 받았어요", &sub);
                }
            }
            lf::Event::Msg { msg } => on_msg(&app, &pk, msg),
            lf::Event::Peer { state, .. } if state == "ready" => {
                let a = app.clone();
                let k = pk.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(50)); // CONNS 등록 뒤
                    hello_after_ready(&a, &k);
                    update_edges(&a);
                    let _ = a.emit("link-devices", ());
                });
            }
            lf::Event::Peer { state, .. } if state == "closed" => {
                let a = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(50));
                    update_edges(&a);
                    let _ = a.emit("link-devices", ());
                });
            }
            _ => {}
        }
        let _ = app.emit("link-files", &e);
    })
}

/// 파일 채널 서버: 링크가 켜질 때 1번 시작 (Hera 수명 동안 유지). 꺼져 있는 동안 들어온 접속은 바로 닫는다.
/// ponytail: 포트 변경은 Hera 재시작 후 반영 — 자주 바꾸면 리스너 재생성으로
pub fn files_start(app: &AppHandle) {
    if !read_cfg(app).0 {
        return;
    }
    // 역할을 바꾸면 그 역할의 채널을 (한 번) 시작한다 — 다른 역할의 것은 스스로 쉰다
    if read_cfg(app).1.role == "sub" {
        static CLIENT: OnceLock<()> = OnceLock::new();
        if CLIENT.set(()).is_ok() {
            files_client(app);
        }
        return;
    }
    if FILES.set(()).is_err() {
        return;
    }
    let port = read_cfg(app).1.file_port;
    let listener = match std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)) {
        Ok(l) => l,
        Err(e) => {
            set(app, |s| s.detail = format!("파일을 주고받을 포트 {port}를 열 수 없어요: {e}"));
            return;
        }
    };
    let a = app.clone();
    std::thread::spawn(move || {
        for st in listener.incoming().flatten() {
            let (on, c) = read_cfg(&a);
            if !on || c.role == "sub" {
                continue; // 꺼져 있거나 받는 쪽인 동안 들어온 접속은 닫는다 (drop)
            }
            let a = a.clone();
            std::thread::spawn(move || {
                let on_conn = |c: Option<Arc<Conn>>| {
                    let mut all = CONNS.lock().unwrap();
                    match c {
                        Some(c) if c.is_ready() => {
                            // 같은 기기가 다시 붙음 → 예전 연결은 닫는다 (다른 기기는 그대로)
                            for old in all.iter().filter(|o| o.peer_pk == c.peer_pk && !Arc::ptr_eq(o, &c)) {
                                old.close();
                            }
                            all.retain(|o| o.peer_pk != c.peer_pk);
                            all.push(c);
                        }
                        Some(c) => {
                            if let Some(old) = PAIRING.lock().unwrap().replace(c) {
                                old.close();
                            }
                        }
                        None => all.retain(|o| o.is_ready()),
                    }
                };
                if let Err(e) = lf::run(st, true, &files_cfg(&a), sink(&a), &on_conn) {
                    eprintln!("link: {e}");
                }
            });
        }
    });
    let name = read_cfg(app).1.me;
    let a3 = app.clone();
    std::thread::spawn(move || {
        let never = std::sync::atomic::AtomicBool::new(false);
        // 여러 기기: 이어져 있어도 계속 알린다 (새 기기가 찾을 수 있게)
        lf::beacon(&name, port, &never, &|| {
            let (on, c) = read_cfg(&a3);
            !on || c.role == "sub"
        });
    });
}

/// 받는 쪽: 중심 PC 의 파일 채널에 접속해 둔다 (끊기면 2→4→…30초 뒤 다시). 주소 = 설정에 적은 것, 없으면 비콘으로 찾기
fn files_client(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut wait = 2u64;
        loop {
            let (on, c) = read_cfg(&app);
            if on && c.role == "sub" {
                let typed = c.server.trim().to_string();
                let addr = if typed.is_empty() {
                    lf::discover(Duration::from_secs(5)).map(|(a, _)| a)
                } else {
                    let host = typed.split(':').next().unwrap_or("").to_string();
                    use std::net::ToSocketAddrs;
                    format!("{host}:{}", c.file_port).to_socket_addrs().ok().and_then(|mut i| i.find(|a| a.is_ipv4()))
                };
                if let Some(a) = addr {
                    if let Ok(s) = app.store("hera.json") {
                        if s.get("link.serverAddr").and_then(|v| v.as_str().map(String::from)).as_deref() != Some(&a.ip().to_string()) {
                            s.set("link.serverAddr", a.ip().to_string());
                            apply(); // 엔진을 그 주소로
                        }
                    }
                    let on_conn = |cn: Option<Arc<Conn>>| {
                        let mut all = CONNS.lock().unwrap();
                        match cn {
                            Some(cn) if cn.is_ready() => {
                                all.retain(|o| o.peer_pk != cn.peer_pk);
                                all.push(cn);
                            }
                            Some(cn) => {
                                if let Some(old) = PAIRING.lock().unwrap().replace(cn) {
                                    old.close();
                                }
                            }
                            None => all.retain(|o| o.is_ready()),
                        }
                    };
                    let started = Instant::now();
                    if let Err(e) = lf::connect(a, &files_cfg(&app), sink(&app), &on_conn) {
                        eprintln!("link client: {e}");
                    }
                    if started.elapsed() > Duration::from_secs(60) {
                        wait = 2;
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(wait));
            wait = (wait * 2).min(30);
        }
    });
}

pub fn pair_confirm(ok: bool) {
    if let Some(c) = PAIRING.lock().unwrap().take() {
        c.confirm(ok);
    }
}

/// 기기 빼기 (id 없으면 모두 — 예전 '페어링 해제'). 맥을 빼면 맥 자리 표시로 돌아간다
pub fn unpair(app: &AppHandle, id: Option<String>) {
    let mut devs = devices(app);
    let gone: Vec<Dev> = devs.iter().filter(|d| id.as_ref().is_none_or(|i| *i == d.id)).cloned().collect();
    devs.retain(|d| !gone.contains(d));
    if gone.iter().any(|d| d.os == "mac") {
        if let Ok(s) = app.store("hera.json") {
            s.delete("link.peerPk");
            s.delete("link.peerName");
        }
        if !devs.iter().any(|d| d.os == "mac") {
            devs.insert(0, Dev { id: "mac".into(), name: read_cfg(app).1.peer, os: "mac".into(), mons: vec![] });
        }
    }
    save_devices(app, &devs);
    for c in CONNS.lock().unwrap().iter().filter(|c| gone.iter().any(|d| d.id == c.peer_pk)) {
        c.close();
    }
    apply();
}

/// 파일을 맥으로 (블로킹 — spawn_blocking 에서). edge = 가장자리 포탈로 보냄 (맥 쪽 방향, 그 가장자리 위 0..1) → 맥이 그 자리에 물결
/// dev = 보낼 기기 (pk). 없으면 첫 기기(맥)
pub fn send_file(app: &AppHandle, path: &str, edge: Option<(String, f64)>) -> Result<(), String> {
    send_file_to(app, path, edge, None)
}

pub fn send_file_to(app: &AppHandle, path: &str, edge: Option<(String, f64)>, dev: Option<&str>) -> Result<(), String> {
    // 보내기 전 실패(연결 없음 · 파일 못 읽음)는 여기서 알린다 — 보낸 뒤의 거절·응답 없음은 Sent 이벤트가 알린다.
    // ponytail: 보내는 도중 끊김은 따로 알리지 않는다 (연결 상태 줄이 '끊김'으로 바뀜)
    let fail = |e: String| {
        let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        crate::tray::toast(app, "fail", "보내지 못했어요", &format!("{name} · {e}"));
        e
    };
    let c = ready().into_iter().find(|c| dev.is_none_or(|d| d == c.peer_pk)).ok_or_else(|| fail("그 기기의 Hera와 연결되어 있지 않아요".into()))?;
    std::fs::File::open(path).map_err(|e| fail(e.to_string()))?;
    match edge {
        Some((side, pos)) => c.send_file_meta(Path::new(path), &sink(app), json!({ "via": "edge", "edge": side, "pos": pos })),
        None => c.send_file(Path::new(path), &sink(app)),
    }
}

/// 맥에서 `mac` 수식키(ctrl/super …)가 되는 윈도우 키 이름 — 키 매핑(윈도우 습관 = Ctrl↔Win)을 거꾸로 따라간다
pub fn win_mod_for(c: &Cfg, mac: &str) -> Option<&'static str> {
    modifiers(c).into_iter().find(|(_, to)| to == mac).map(|(from, _)| from)
}

/// 한/영 대체 방법: 맥 전환 단축키를 SendInput 으로 만들어 엔진이 맥으로 실어 보내게 (엔진이 주입 키를 넘기는지는 미확인 — 실험적).
/// "ctrl-space" = 맥에서 ^Space, "cmd-space" = 맥에서 ⌘Space — 키 매핑으로 바뀌는 만큼 윈도우 쪽 키를 고른다.
#[cfg(windows)]
fn send_switch_shortcut(method: &str, c: &Cfg) {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    let vk = |k: &str| match k {
        "shift" => VK_SHIFT,
        "ctrl" => VK_CONTROL,
        "alt" => VK_MENU,
        "altgr" => VK_RMENU,
        _ => VK_LWIN, // super · meta
    };
    let m = |mac: &str| win_mod_for(c, mac).map(vk);
    let keys: Vec<VIRTUAL_KEY> = match method {
        "capslock" => vec![VK_CAPITAL],
        "ctrl-space" => m("ctrl").into_iter().chain([VK_SPACE]).collect(),
        "cmd-space" => m("super").into_iter().chain([VK_SPACE]).collect(),
        _ => return,
    };
    if keys.len() < 2 && method != "capslock" {
        return; // 매핑에 그 맥 수식키가 없음
    }
    let ev = |vk: VIRTUAL_KEY, up: bool| INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() }, ..Default::default() } } };
    let inputs: Vec<INPUT> = keys.iter().map(|&k| ev(k, false)).chain(keys.iter().rev().map(|&k| ev(k, true))).collect();
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// 첫 이어진 기기 이름 (예전 '맥 연결됨' 자리)
pub fn files_connected() -> Option<String> {
    ready().first().map(|c| c.peer_name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 한/영 대체 단축키: '윈도우 습관'(Ctrl↔Win)이면 맥 ^Space 는 Win 키로, ⌘Space 는 Ctrl 키로 보내야 한다
    #[test]
    fn switch_shortcut_follows_keymap() {
        let mut c = Cfg::default();
        c.keymap = "habit".into();
        assert_eq!(win_mod_for(&c, "ctrl"), Some("super"));
        assert_eq!(win_mod_for(&c, "super"), Some("ctrl"));
        c.keymap = "position".into();
        assert_eq!(win_mod_for(&c, "ctrl"), Some("ctrl"));
        c.keymap = "custom".into();
        c.key_rows = vec![("alt".into(), "ctrl".into()), ("ctrl".into(), "none".into())];
        assert_eq!(win_mod_for(&c, "ctrl"), Some("alt"));
    }

    fn cfg(side: &str) -> Cfg {
        Cfg { me: "DEV-PC".into(), peer: "MacBook".into(), side: side.into(), port: 24900, ..Cfg::default() }
    }
    fn mac() -> Vec<(String, String)> {
        vec![("mac".into(), "MacBook".into())]
    }

    #[test]
    fn several_devices_and_client_mode() {
        // 맥 + 윈도우 노트북: 노트북에는 수식키 매핑이 없다 (윈도우끼리)
        let ini = settings_ini(&cfg("right"), &[("MacBook".into(), true), ("LAPTOP".into(), false)], Path::new("c"), Path::new("p"));
        assert!(ini.contains("[computer_MacBook]\nname=MacBook\nmodifierShift=shift"));
        assert!(ini.ends_with("[computer_LAPTOP]\nname=LAPTOP\n"));
        // 받는 쪽(sub) 엔진: 클라이언트 모드, 중심 PC 주소
        let ci = client_ini(&cfg("right"), "192.168.0.10", Path::new(r"C:\x\tls\deskflow.pem"));
        assert!(ci.contains("coreMode=1\n") && ci.contains("[client]\nremoteHost=192.168.0.10\n") && ci.contains("computerName=DEV-PC\n") && ci.contains("port=24900\n"));
        assert!(ci.contains("certificate=C:/x/tls/deskflow.pem\n") && ci.contains("checkPeerFingerprints=true\n"));
        assert_eq!(parse_line("[t] NOTE: connected to server"), Some(LogEv::Connected { name: String::new() }));
        assert_eq!(parse_line("[t] WARNING: failed to connect to server: Timed out"), None);
        assert_eq!(parse_line("[t] NOTE: disconnected from server"), Some(LogEv::Disconnected { name: String::new() }));
    }

    #[test]
    fn config_generation() {
        let s = server_conf(&cfg("right"), &mac(), &[]);
        assert_eq!(s, "section: links\n\tDEV-PC:\n\t\tright = MacBook\n\tMacBook:\n\t\tleft = DEV-PC\nend\n\nsection: options\nend\n");
        assert!(server_conf(&cfg("top"), &mac(), &[]).contains("\t\tup = MacBook\n\tMacBook:\n\t\tdown = DEV-PC"));
        assert!(server_conf(&cfg("bottom"), &mac(), &[]).contains("down = MacBook"));
        assert!(server_conf(&cfg("left"), &mac(), &[]).contains("left = MacBook"));
        assert!(!server_conf(&cfg("right"), &mac(), &[]).contains("screens")); // 1.27 은 screens 섹션을 무시(경고)
        let seg = crate::link_layout::Seg { dev: "mac".into(), side: "right".into(), win: (50.0, 100.0), mac: (0.0, 54.99), edge: [0.0; 4] };
        assert!(server_conf(&cfg("right"), &mac(), &[seg]).contains("\t\tright(50,100) = MacBook(0,54.99)\n\tMacBook:\n\t\tleft(0,54.99) = DEV-PC(50,100)\n"));
        let ini = settings_ini(&cfg("right"), &[("MacBook".into(), true)], Path::new(r"C:\x\server.conf"), Path::new(r"C:\x\settings\tls\deskflow.pem"));
        assert!(ini.contains("port=24900\n") && ini.contains("computerName=DEV-PC\n") && ini.contains("coreMode=2\n"));
        assert!(ini.contains("externalConfigFile=C:/x/server.conf\n") && ini.contains("certificate=C:/x/settings/tls/deskflow.pem\n"));
        assert!(ini.contains("tlsEnabled=true\n") && ini.contains("protocol=barrier\n"));
        // 이름은 INI 의 [computer_*] 에서 (1.27), 수식키는 맥 쪽 섹션에
        assert!(ini.contains("[computer_DEV-PC]\nname=DEV-PC\n") && ini.contains("[computer_MacBook]\nname=MacBook\n"));
        assert!(ini.contains("modifierCtrl=super\n") && ini.contains("modifierSuper=ctrl\n")); // 기본 프리셋 = 윈도우 습관대로
    }

    #[test]
    fn key_presets() {
        let get = |c: &Cfg| modifiers(c).into_iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",");
        let base = cfg("right");
        assert_eq!(get(&Cfg { keymap: "habit".into(), ..base.clone() }), "shift=shift,ctrl=super,alt=alt,altgr=altgr,meta=meta,super=ctrl");
        assert_eq!(get(&Cfg { keymap: "position".into(), ..base.clone() }), "shift=shift,ctrl=ctrl,alt=alt,altgr=altgr,meta=meta,super=super");
        assert_eq!(get(&Cfg { keymap: "shortcuts".into(), ..base.clone() }), "shift=shift,ctrl=ctrl,alt=alt,altgr=altgr,meta=meta,super=super");
        let custom = Cfg { keymap: "custom".into(), key_rows: vec![("alt".into(), "super".into()), ("super".into(), "alt".into()), ("altgr".into(), "none".into()), ("bogus".into(), "ctrl".into()), ("ctrl".into(), "xyz".into())], ..base.clone() };
        assert_eq!(get(&custom), "shift=shift,ctrl=ctrl,alt=super,altgr=none,meta=meta,super=alt");
        let ini = settings_ini(&custom, &[("MacBook".into(), true)], Path::new("c"), Path::new("p"));
        assert!(ini.ends_with("[computer_MacBook]\nname=MacBook\nmodifierShift=shift\nmodifierCtrl=ctrl\nmodifierAlt=super\nmodifierAltGr=none\nmodifierMeta=meta\nmodifierSuper=alt\n"));
    }

    #[test]
    fn log_parsing() {
        let p = |s: &str| parse_line(s);
        assert_eq!(p(r#"[2026-11-15T12:03:00.851] INFO: switch from "DEV-PC" to "MacBook" at 1919,500"#), Some(LogEv::Switch { from: "DEV-PC".into(), to: "MacBook".into(), at: Some((1919, 500)) }));
        assert_eq!(p(r#"[t] INFO: jump from "MacBook" to "DEV-PC" at 5,5"#), Some(LogEv::Switch { from: "MacBook".into(), to: "DEV-PC".into(), at: Some((5, 5)) }));
        assert_eq!(p(r#"[t] INFO: switch from "A" to "B" at 0,-3"#), Some(LogEv::Switch { from: "A".into(), to: "B".into(), at: Some((0, -3)) }));
        assert_eq!(p("[t] INFO: accepted client connection"), Some(LogEv::Connected { name: String::new() }));
        assert_eq!(p(r#"[t] DEBUG: client "MacBook" has connected"#), Some(LogEv::Connected { name: "MacBook".into() }));
        assert_eq!(p(r#"[t] INFO: disconnecting client "MacBook""#), Some(LogEv::Disconnected { name: "MacBook".into() }));
        assert_eq!(p("[t] WARNING: fingerprint does not match trusted fingerprint"), Some(LogEv::Untrusted));
        assert_eq!(p("[t] INFO: peer fingerprint: SHA256:24:D2:CA"), Some(LogEv::Fingerprint { fp: "24d2ca".into() }));
        assert!(matches!(p("[t] FATAL: failed to create event for windows event loop"), Some(LogEv::Error { msg }) if msg.contains("Deskflow 앱을 먼저 종료")));
        assert!(matches!(p("[t] ERROR: tls certificate doesn't exist: C:/x.pem"), Some(LogEv::Error { msg }) if msg.contains("암호화 인증서")));
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
    fn self_signed_cert() {
        let p = std::env::temp_dir().join(format!("hera-cert-{}.pem", std::process::id()));
        let _ = std::fs::remove_file(&p);
        ensure_cert(&p, "DEV-PC").unwrap();
        let pem = std::fs::read_to_string(&p).unwrap();
        assert!(pem.contains("BEGIN PRIVATE KEY") && pem.contains("BEGIN CERTIFICATE"));
        assert_eq!(cert_fp(&pem).unwrap().len(), 64); // 지문 계산 가능 (맥에 건넬 값)
        ensure_cert(&p, "other").unwrap(); // 있으면 그대로
        assert_eq!(std::fs::read_to_string(&p).unwrap(), pem);
        let _ = std::fs::remove_file(&p);
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
