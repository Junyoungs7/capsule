// 사람에게 파일 보내기 (같은 사무실 네트워크의 다른 Hera). 맥 연결(link.rs · 24810)과 따로 돈다 — 맥 쪽 동작은 그대로.
// 발견: 3초마다 UDP 24813 브로드캐스트 {"hera-people":1,"name","port","pk"} + 같은 포트를 들어 근처 목록 (10초 안 들리면 빠짐).
// 등록: 근처 사람을 누르면 TCP 24812 로 접속 → link_files 의 숫자 비교 페어링 (양쪽 같은 숫자 확인) → store `people:<pk>`.
// 받기: 등록한 사람만 (모르는 사람의 접속은 '등록 요청'으로만 — 받는 사람이 확인하기 전에는 파일이 오지 않는다).
// 보내기: 보낼 때마다 접속 → 준비되면 파일들 → 닫기. 파일만 주고받는다 (클립보드 · 마우스는 맥 전용).
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::Path;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

use crate::link_files::{self as lf, Conn};

pub const PORT: u16 = 24812;
pub const BEACON: u16 = 24813;
const GONE: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct Near {
    pk: String,
    name: String,
    addr: SocketAddr,
    seen: Instant,
}

static NEAR: Mutex<Vec<Near>> = Mutex::new(Vec::new());
/// 숫자 확인을 기다리는 등록 연결 (한 번에 하나)
static PAIRING: Mutex<Option<Arc<Conn>>> = Mutex::new(None);
static STARTED: OnceLock<()> = OnceLock::new();

pub fn enabled(app: &AppHandle) -> bool {
    crate::flag(app, "people.enabled", true)
}

/// 내 이름 (store `people.name`, 없으면 Windows 사용자 이름)
pub fn my_name(app: &AppHandle) -> String {
    app.store("hera.json")
        .ok()
        .and_then(|s| s.get("people.name"))
        .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USERNAME").ok())
        .unwrap_or_else(|| "Hera".into())
}

/// 내 공개키 hex
pub fn my_pk(app: &AppHandle) -> String {
    lf::hex(&lf::public_of(&crate::link::files_cfg(app).secret))
}

/// 등록한 사람 (pk, 이름)
pub fn registered(app: &AppHandle) -> Vec<(String, String)> {
    let Ok(s) = app.store("hera.json") else { return vec![] };
    s.entries().into_iter().filter_map(|(k, v)| Some((k.strip_prefix("people:")?.to_string(), v["name"].as_str().unwrap_or("?").to_string()))).collect()
}

/// 지금 켜진 등록한 사람 pk (fav = 친한 친구 ⭐ 만)
pub fn online(app: &AppHandle, fav: bool) -> Vec<String> {
    let Ok(s) = app.store("hera.json") else { return vec![] };
    let n = NEAR.lock().unwrap();
    n.iter()
        .filter(|x| x.seen.elapsed() < GONE)
        .filter(|x| s.get(format!("people:{}", x.pk)).is_some_and(|v| !fav || v["fav"] == true))
        .map(|x| x.pk.clone())
        .collect()
}

fn known(app: &AppHandle) -> Vec<[u8; 32]> {
    let Ok(s) = app.store("hera.json") else { return vec![] };
    s.keys().iter().filter_map(|k| k.strip_prefix("people:").and_then(lf::unhex32)).collect()
}

fn cfg(app: &AppHandle) -> lf::Config {
    let mut c = crate::link::files_cfg(app); // 같은 장기 키 (이 PC 의 신원)
    c.name = my_name(app);
    c.known_peer = None;
    c.known = known(app);
    c.engine_fp = String::new();
    c
}

/// 비콘 한 줄 → (pk, 이름, 포트). 내 것 · 다른 버전은 None
pub fn parse_beacon(b: &[u8], me: &str) -> Option<(String, String, u16)> {
    let v: Value = serde_json::from_slice(b).ok()?;
    if v["hera-people"].as_u64() != Some(1) {
        return None;
    }
    let pk = v["pk"].as_str()?.to_string();
    lf::unhex32(&pk)?;
    if pk == me {
        return None;
    }
    let name: String = v["name"].as_str().unwrap_or("?").chars().filter(|c| !c.is_control()).take(40).collect();
    Some((pk, name, v["port"].as_u64().filter(|p| *p > 0 && *p <= u16::MAX as u64)? as u16))
}

/// 근처 목록 [{pk, name, known}] (10초 안에 들린 사람) — 패널 · 끌기 오버레이
fn near_json(app: &AppHandle) -> Value {
    let ks: Vec<String> = known(app).iter().map(|k| lf::hex(k)).collect();
    let n = NEAR.lock().unwrap();
    json!(n.iter().filter(|x| x.seen.elapsed() < GONE).map(|x| json!({ "pk": x.pk, "name": x.name, "known": ks.contains(&x.pk) })).collect::<Vec<_>>())
}

fn changed(app: &AppHandle) {
    let _ = app.emit("people-near", near_json(app));
}

/// 지금 켜져 있는 등록한 사람 수 (끌기 오버레이: 가장자리 사람 포탈을 열지)
pub fn online_count(app: &AppHandle) -> usize {
    let ks: Vec<String> = known(app).iter().map(|k| lf::hex(k)).collect();
    NEAR.lock().unwrap().iter().filter(|x| x.seen.elapsed() < GONE && ks.contains(&x.pk)).count()
}

fn addr_of(pk: &str) -> Option<SocketAddr> {
    NEAR.lock().unwrap().iter().find(|x| x.pk == pk && x.seen.elapsed() < GONE).map(|x| x.addr)
}

/// 시작 때 한 번 (켜져 있을 때): 받기 대기 · 비콘 보내기 · 비콘 듣기
pub fn start(app: &AppHandle) {
    if !enabled(app) || STARTED.set(()).is_err() {
        return;
    }
    let me = lf::hex(&lf::public_of(&cfg(app).secret));
    match TcpListener::bind((Ipv4Addr::UNSPECIFIED, PORT)) {
        Ok(listener) => {
            let a = app.clone();
            std::thread::spawn(move || {
                for s in listener.incoming().flatten() {
                    let a = a.clone();
                    std::thread::spawn(move || {
                        let r = lf::run(s, true, &cfg(&a), sink(&a, Mode::Incoming), &hold_pairing);
                        if let Err(e) = r {
                            eprintln!("people: {e}");
                        }
                    });
                }
            });
        }
        Err(e) => eprintln!("people: 포트 {PORT}를 열 수 없어요: {e}"),
    }
    let a = app.clone();
    let pk = me.clone();
    std::thread::spawn(move || loop {
        if enabled(&a) {
            let msg = json!({ "hera-people": 1, "name": my_name(&a), "port": PORT, "pk": pk }).to_string();
            lf::broadcast(msg.as_bytes(), BEACON);
        }
        std::thread::sleep(Duration::from_secs(3));
    });
    let a = app.clone();
    std::thread::spawn(move || {
        let Ok(sock) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, BEACON)) else {
            eprintln!("people: 비콘 포트 {BEACON}를 열 수 없어요");
            return;
        };
        let _ = sock.set_read_timeout(Some(Duration::from_secs(3)));
        let mut buf = [0u8; 512];
        let mut shown: Vec<String> = vec![];
        loop {
            if let Ok((n, from)) = sock.recv_from(&mut buf) {
                if let Some((pk, name, port)) = parse_beacon(&buf[..n], &me) {
                    let addr = SocketAddr::new(from.ip(), port);
                    let mut l = NEAR.lock().unwrap();
                    match l.iter_mut().find(|x| x.pk == pk) {
                        Some(x) => (x.name, x.addr, x.seen) = (name, addr, Instant::now()),
                        None => l.push(Near { pk, name, addr, seen: Instant::now() }),
                    }
                }
            }
            // 목록(10초 기준)이 바뀐 때만 알린다
            let now: Vec<String> = {
                let mut l = NEAR.lock().unwrap();
                l.retain(|x| x.seen.elapsed() < GONE * 6);
                l.iter().filter(|x| x.seen.elapsed() < GONE).map(|x| format!("{}={}", x.pk, x.name)).collect()
            };
            if now != shown {
                shown = now;
                changed(&a);
            }
        }
    });
}

/// 등록 확인을 기다리는 연결은 PAIRING 에 (확인 · 취소는 people_confirm)
fn hold_pairing(c: Option<Arc<Conn>>) {
    if let Some(c) = c.filter(|c| !c.is_ready()) {
        if let Some(old) = PAIRING.lock().unwrap().replace(c) {
            old.close();
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// 상대가 건 연결 (받기 · 등록 요청)
    Incoming,
    /// 내가 건 등록 요청
    Pair,
    /// 내가 건 보내기 (숫자 확인은 보이지 않는다 — 등록이 풀렸으면 그냥 실패)
    Send,
}

/// 연결 1개의 이벤트 처리
fn sink(app: &AppHandle, mode: Mode) -> lf::Sink {
    let app = app.clone();
    let peer = Arc::new(Mutex::new((String::new(), String::new()))); // (이름, pk)
    Arc::new(move |e: lf::Event| match e {
        lf::Event::Peer { state, name, code, pk } => {
            *peer.lock().unwrap() = (name.clone(), pk);
            if state == "pairing" && mode != Mode::Send {
                let code: String = code.chars().take(4).collect();
                let _ = app.emit("people-pair", json!({ "name": name, "code": code }));
                if mode == Mode::Incoming {
                    crate::tray::toast(&app, "pair", &format!("{name}님이 등록을 요청했어요"), &format!("숫자 {code} · 눌러서 확인"));
                }
            } else if state == "closed" && mode != Mode::Send {
                let _ = app.emit("people-pair", Value::Null);
            }
        }
        lf::Event::Paired { pk, name, .. } => {
            if let Ok(s) = app.store("hera.json") {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
                s.set(format!("people:{pk}"), json!({ "id": pk, "name": name, "at": now }));
            }
            let _ = app.emit("people-pair", Value::Null);
            crate::tray::toast(&app, "sent", &format!("{name}님을 등록했어요"), "이제 서로 파일을 보낼 수 있어요");
            changed(&app);
        }
        lf::Event::Received { path, .. } => {
            let from = peer.lock().unwrap().0.clone();
            let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            crate::shelve(&app, std::slice::from_ref(&path), &from);
            let _ = app.emit_to("pet", "pet-react", "recv");
            crate::tray::toast(&app, "recv", &format!("{from}님이 파일을 보냈어요"), &format!(r"{name} · 선반과 다운로드\Hera에 있어요"));
        }
        lf::Event::Sent { ok: true, .. } => {
            let _ = app.emit_to("pet", "pet-react", "sent");
        }
        // 톡 · 빠른 톡 · 초대 — 준비된(= 등록한 사람끼리의) 연결에서만 온다
        lf::Event::Msg { msg } => {
            let (name, pk) = peer.lock().unwrap().clone();
            crate::talk::received(&app, &pk, &name, &msg);
        }
        _ => {}
    })
}

/// 등록 요청: 근처 사람(pk)에게 접속 → 양쪽에 같은 숫자 → 확인은 people_confirm
#[tauri::command]
pub fn people_pair(app: AppHandle, pk: String) -> Result<(), String> {
    let addr = addr_of(&pk).ok_or("지금 근처에 없어요")?;
    let s = TcpStream::connect_timeout(&addr, Duration::from_secs(4)).map_err(|e| format!("연결하지 못했어요: {e}"))?;
    std::thread::spawn(move || {
        let r = lf::run(s, false, &cfg(&app), sink(&app, Mode::Pair), &hold_pairing);
        if let Err(e) = r {
            eprintln!("people pair: {e}");
            let _ = app.emit("people-pair", Value::Null);
        }
    });
    Ok(())
}

/// 숫자 확인 (같아요 = true). 등록이 끝나면 연결은 닫는다
#[tauri::command]
pub fn people_confirm(ok: bool) {
    if let Some(c) = PAIRING.lock().unwrap().take() {
        c.confirm(ok);
        let c2 = c.clone();
        std::thread::spawn(move || {
            // 준비(ready)되면 할 일이 없다 → 닫기 (상대가 먼저 닫으면 그대로)
            for _ in 0..40 {
                if c2.is_ready() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            std::thread::sleep(Duration::from_millis(300));
            c2.close();
        });
    }
}

/// 근처 목록 (패널 · 오버레이가 처음 열 때)
#[tauri::command]
pub fn people_near(app: AppHandle) -> Value {
    near_json(&app)
}

/// 등록 지우기 (상대 쪽 등록은 남는다 — 이쪽이 받지 않을 뿐)
#[tauri::command]
pub fn people_forget(app: AppHandle, pk: String) {
    if let Ok(s) = app.store("hera.json") {
        s.delete(format!("people:{pk}"));
    }
    changed(&app);
}

/// 등록한 사람에게 접속해 준비된 연결 (6초). 상대가 나를 지웠으면 숫자 확인으로 넘어가지 않고 실패
fn open(app: &AppHandle, pk: &str) -> Result<Arc<Conn>, String> {
    let addr = addr_of(pk).ok_or("지금 Hera가 꺼져 있거나 근처에 없어요")?;
    let s = TcpStream::connect_timeout(&addr, Duration::from_secs(4)).map_err(|e| e.to_string())?;
    let (tx, rx) = channel::<Arc<Conn>>();
    let tx = Mutex::new(Some(tx));
    let a = app.clone();
    std::thread::spawn(move || {
        let _ = lf::run(s, false, &cfg(&a), sink(&a, Mode::Send), &|c| match c {
            Some(c) if c.is_ready() => {
                if let Some(t) = tx.lock().unwrap().take() {
                    let _ = t.send(c);
                }
            }
            Some(c) => c.close(),
            None => {}
        });
    });
    rx.recv_timeout(Duration::from_secs(6)).map_err(|_| "상대가 받지 않았어요 (서로 등록되어 있어야 해요)".to_string())
}

/// 제어 메시지 하나를 여러 사람에게 (사람마다 스레드 · 접속 → 보내기 → 닫기). 꺼진 사람은 조용히 건너뜀
pub fn deliver(app: &AppHandle, pks: Vec<String>, msg: Value) {
    for pk in pks {
        let (a, m) = (app.clone(), msg.clone());
        std::thread::spawn(move || {
            if let Ok(c) = open(&a, &pk) {
                let _ = c.send(m);
                std::thread::sleep(Duration::from_millis(200));
                c.close();
            }
        });
    }
}

/// 파일들을 한 사람에게 (블로킹). 실패는 알림으로, 성공은 '보냈어요' 알림
pub fn send_files(app: &AppHandle, pk: &str, paths: &[String]) {
    let who = app.store("hera.json").ok().and_then(|s| s.get(format!("people:{pk}"))).and_then(|v| v["name"].as_str().map(String::from));
    let first = paths.first().and_then(|p| Path::new(p).file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let fail = |e: &str| crate::tray::toast(app, "fail", "보내지 못했어요", &format!("{} · {first} · {e}", who.as_deref().unwrap_or("?")));
    let Some(who) = who.clone() else { return fail("등록한 사람이 아니에요") };
    let c = match open(app, pk) {
        Ok(c) => c,
        Err(e) => return fail(&e),
    };
    let mut sent = 0;
    for p in paths {
        match c.send_file(Path::new(p), &sink(app, Mode::Send)) {
            Ok(()) => sent += 1,
            Err(e) => fail(&e),
        }
    }
    c.close();
    if sent > 0 {
        let more = if sent > 1 { format!(" 외 {}개", sent - 1) } else { String::new() };
        crate::tray::toast(app, "sent", &format!("{who}님에게 보냈어요"), &format!("{first}{more} · 상대 선반에 들어갔어요"));
    }
}

/// 파일들을 등록한 사람에게 (스레드)
#[tauri::command]
pub fn people_send(app: AppHandle, pk: String, paths: Vec<String>) {
    std::thread::spawn(move || send_files(&app, &pk, &paths));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beacons() {
        let pk = "ab".repeat(32);
        let b = format!(r#"{{"hera-people":1,"name":"박지윤","port":24812,"pk":"{pk}"}}"#);
        assert_eq!(parse_beacon(b.as_bytes(), "me"), Some((pk.clone(), "박지윤".into(), 24812)));
        assert_eq!(parse_beacon(b.as_bytes(), &pk), None, "내 비콘은 무시");
        assert_eq!(parse_beacon(br#"{"hera":1,"name":"mac","port":24810}"#, "me"), None, "맥 비콘(다른 종류)은 무시");
        assert_eq!(parse_beacon(br#"{"hera-people":1,"name":"x","port":24812,"pk":"zz"}"#, "me"), None, "잘못된 키");
        let bad = format!(r#"{{"hera-people":1,"name":"x","port":70000,"pk":"{pk}"}}"#);
        assert_eq!(parse_beacon(bad.as_bytes(), "me"), None, "잘못된 포트");
        let long = format!(r#"{{"hera-people":1,"name":"{}\n","port":1,"pk":"{pk}"}}"#, "가".repeat(60));
        assert_eq!(parse_beacon(long.as_bytes(), "me").unwrap().1.chars().count(), 40, "이름은 40자 · 제어 문자 없이");
    }
}
