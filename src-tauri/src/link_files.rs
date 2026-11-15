// Hera Link 파일 채널 (윈도우·맥 공용 — 플랫폼 코드 없음). 규격: docs/hera-link-protocol.md
// TCP 1개: 윈도우 = 대기(서버), 맥 = 접속(클라이언트). 발견 = UDP 비콘. 페어링 = 양쪽 6자리 코드 확인(숫자 비교).
// 키: X25519(정적 + 임시) 두 번의 DH → HKDF-SHA256 → 방향별 ChaCha20-Poly1305 키. 프레임 = u32(BE) 길이 + 내용.
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

pub const VERSION: u64 = 1;
pub const MAX_FRAME: usize = 1 << 20;
const CHUNK: usize = 64 * 1024;
pub const BEACON_PORT: u16 = 24811;
const T_JSON: u8 = 1;
const T_CHUNK: u8 = 2;

#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    /// state: pairing(코드 확인 대기) / ready / closed
    Peer { state: String, name: String, code: String },
    /// 새로 페어링됨 → 저장할 것 (pk hex, 상대 엔진 TLS 지문)
    Paired { pk: String, name: String, fp: String },
    Xfer { dir: String, id: u32, name: String, bytes: u64, size: u64 },
    /// meta = offer 의 부가 필드 (via: "edge" 면 화면 가장자리로 끌어 보낸 것, edge·pos)
    Received { id: u32, path: String, meta: Value },
    Sent { id: u32, ok: bool, error: String },
    Clip { text: String },
    /// 이 모듈이 모르는 메시지 (monitors · crossed · ambient · sync · ime · keymap …) — 위층(link.rs)이 처리
    Msg { msg: Value },
}

pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;
type AckTx = Sender<(bool, String)>;

/// 이 끝점의 설정 (Tauri 쪽이 store 에서 채운다; 시험은 직접)
pub struct Config {
    pub name: String,
    pub secret: [u8; 32],
    pub known_peer: Option<[u8; 32]>,
    pub engine_fp: String,
    pub downloads: PathBuf,
    /// Hera Team: 숫자 비교 페어링 없이 바로 준비 (신원 확인은 위층 — 그룹원 공개키·초대 코드)
    pub accept_any: bool,
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex32(s: &str) -> Option<[u8; 32]> {
    let v: Vec<u8> = (0..s.len()).step_by(2).filter_map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect();
    v.try_into().ok()
}

pub fn random32() -> [u8; 32] {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("getrandom");
    b
}

pub fn public_of(secret: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

/* ── 프레임 ── */
pub fn write_frame(w: &mut impl Write, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&(payload.len() as u32).to_be_bytes())?;
    w.write_all(payload)
}

pub fn read_frame(r: &mut impl Read) -> std::io::Result<Vec<u8>> {
    read_frame_until(r, &AtomicBool::new(false))
}

/// 짧은 읽기 제한시간(소켓 read timeout)마다 closed 를 확인한다 — 프레임 중간이면 이어서 읽어 데이터는 잃지 않는다.
/// (같은 소켓을 다른 핸들로 shutdown 해도 막힌 recv 가 안 깨는 경우가 있어, 닫기를 이 깃발로 확실히 끝낸다)
fn read_full(r: &mut impl Read, buf: &mut [u8], closed: &AtomicBool) -> std::io::Result<()> {
    use std::io::ErrorKind::*;
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => return Err(UnexpectedEof.into()),
            Ok(k) => n += k,
            Err(e) if matches!(e.kind(), WouldBlock | TimedOut | Interrupted) => {
                if closed.load(Ordering::Relaxed) {
                    return Err(ConnectionAborted.into());
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn read_frame_until(r: &mut impl Read, closed: &AtomicBool) -> std::io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    read_full(r, &mut len, closed)?;
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut v = vec![0u8; n];
    read_full(r, &mut v, closed)?;
    Ok(v)
}

/* ── 키 유도 ── */
pub struct Keys {
    pub send: [u8; 32],
    pub recv: [u8; 32],
    pub code: String,
}

/// server = 대기 쪽 여부. 전사(transcript) 순서는 항상 (클라이언트, 서버) — 양쪽이 같은 값을 얻는다.
pub fn derive(server: bool, my_static: &[u8; 32], my_eph: &[u8; 32], peer_static: &[u8; 32], peer_eph: &[u8; 32]) -> Keys {
    let (ss, es) = (StaticSecret::from(*my_static), StaticSecret::from(*my_eph));
    let dh1 = es.diffie_hellman(&PublicKey::from(*peer_eph));
    let dh2 = ss.diffie_hellman(&PublicKey::from(*peer_static));
    let mut ikm = dh1.as_bytes().to_vec();
    ikm.extend_from_slice(dh2.as_bytes());
    let (mp, me) = (public_of(my_static), public_of(my_eph));
    let (cs, ce, sp, se) = if server { (*peer_static, *peer_eph, mp, me) } else { (mp, me, *peer_static, *peer_eph) };
    let h = Hkdf::<Sha256>::new(Some(b"hera-link-v1"), &ikm);
    let okm = |label: &[u8], out: &mut [u8]| {
        let info: Vec<u8> = [label, &cs, &sp, &ce, &se].concat();
        h.expand(&info, out).expect("hkdf");
    };
    let (mut c2s, mut s2c, mut code) = ([0u8; 32], [0u8; 32], [0u8; 4]);
    okm(b"c2s", &mut c2s);
    okm(b"s2c", &mut s2c);
    okm(b"code", &mut code);
    let code = format!("{:06}", u32::from_be_bytes(code) % 1_000_000);
    if server { Keys { send: s2c, recv: c2s, code } } else { Keys { send: c2s, recv: s2c, code } }
}

fn nonce(n: u64) -> [u8; 12] {
    let mut b = [0u8; 12];
    b[4..].copy_from_slice(&n.to_be_bytes());
    b
}

/* ── 연결 ── */
struct Tx {
    stream: TcpStream,
    aead: ChaCha20Poly1305,
    n: u64,
}

impl Tx {
    fn send(&mut self, kind: u8, body: &[u8]) -> std::io::Result<()> {
        let mut pt = Vec::with_capacity(body.len() + 1);
        pt.push(kind);
        pt.extend_from_slice(body);
        let ct = self.aead.encrypt(Nonce::from_slice(&nonce(self.n)), pt.as_slice()).map_err(|_| std::io::Error::other("encrypt"))?;
        self.n += 1;
        write_frame(&mut self.stream, &ct)
    }
}

struct Rx {
    stream: BufReader<TcpStream>,
    aead: ChaCha20Poly1305,
    n: u64,
    closed: Arc<AtomicBool>,
}

impl Rx {
    fn recv(&mut self) -> std::io::Result<(u8, Vec<u8>)> {
        let ct = read_frame_until(&mut self.stream, &self.closed)?;
        let mut pt = self.aead.decrypt(Nonce::from_slice(&nonce(self.n)), ct.as_slice()).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "decrypt (bad key or tampered)"))?;
        self.n += 1;
        if pt.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "empty"));
        }
        let kind = pt.remove(0);
        Ok((kind, pt))
    }
}

/// 살아 있는 연결 1개
pub struct Conn {
    tx: Mutex<Tx>,
    pub peer_name: String,
    /// 상대 장기 공개키 (Hera Team 그룹원 확인용)
    pub peer_pk: [u8; 32],
    ready: AtomicBool,
    next_id: AtomicU32,
    confirm: Mutex<Option<Sender<bool>>>,
    acks: Mutex<Vec<(u32, AckTx)>>,
    closed: Arc<AtomicBool>,
}

impl Conn {
    fn json(&self, v: Value) -> std::io::Result<()> {
        self.tx.lock().unwrap().send(T_JSON, v.to_string().as_bytes())
    }

    /// 준비된 연결로 제어 메시지 1개 (monitors · crossed · ambient · sync · ime …)
    pub fn send(&self, v: Value) -> std::io::Result<()> {
        if !self.is_ready() {
            return Err(std::io::Error::new(std::io::ErrorKind::NotConnected, "not ready"));
        }
        self.json(v)
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Relaxed)
    }

    /// 페어링 코드 확인 결과 (사용자가 양쪽에서 같은 6자리를 보고 누름)
    pub fn confirm(&self, ok: bool) {
        if let Some(tx) = self.confirm.lock().unwrap().take() {
            let _ = tx.send(ok);
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn send_clip(&self, text: &str) -> std::io::Result<()> {
        self.json(json!({ "t": "clip", "text": text }))
    }

    /// 닫기: 상대에게 bye (상대 읽기 루프가 바로 끝남) → 내 읽기 루프도 closed 깃발로 0.5초 안에 끝남 → 소켓 shutdown
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        // 핸드셰이크가 끝난 연결이면 bye (실패해도 상관없음)
        let _ = self.json(json!({ "t": "bye" }));
        let _ = self.tx.lock().unwrap().stream.shutdown(std::net::Shutdown::Both);
    }

    /// 파일 보내기 (블로킹: 해시 → offer → chunk… → done → ack 대기). 진행은 sink 로.
    pub fn send_file(&self, path: &Path, sink: &Sink) -> Result<(), String> {
        self.send_file_meta(path, sink, json!({}))
    }

    /// meta 는 offer 에 합쳐 보낸다 (예: {"via":"edge","edge":"right","pos":0.42})
    pub fn send_file_meta(&self, path: &Path, sink: &Sink, meta: Value) -> Result<(), String> {
        if !self.is_ready() {
            return Err("연결이 준비되지 않았어요".into());
        }
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("파일 이름 없음")?;
        let mut f = File::open(path).map_err(|e| e.to_string())?;
        let size = f.metadata().map_err(|e| e.to_string())?.len();
        let mut h = Sha256::new();
        std::io::copy(&mut f, &mut h).map_err(|e| e.to_string())?;
        let sha = hex(&h.finalize());
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (ack_tx, ack_rx) = channel();
        self.acks.lock().unwrap().push((id, ack_tx));
        let io = |e: std::io::Error| e.to_string();
        let mut offer = json!({ "t": "offer", "id": id, "name": name, "size": size, "sha256": sha });
        if let (Some(o), Some(m)) = (offer.as_object_mut(), meta.as_object()) {
            for (k, v) in m {
                o.entry(k.clone()).or_insert(v.clone());
            }
        }
        self.json(offer).map_err(io)?;
        let mut f = File::open(path).map_err(io)?;
        let (mut buf, mut sent, mut last) = (vec![0u8; CHUNK], 0u64, Instant::now());
        loop {
            let n = f.read(&mut buf).map_err(io)?;
            if n == 0 {
                break;
            }
            let mut body = id.to_be_bytes().to_vec();
            body.extend_from_slice(&buf[..n]);
            self.tx.lock().unwrap().send(T_CHUNK, &body).map_err(io)?;
            sent += n as u64;
            if last.elapsed() > Duration::from_millis(100) || sent == size {
                last = Instant::now();
                sink(Event::Xfer { dir: "out".into(), id, name: name.clone(), bytes: sent, size });
            }
        }
        self.json(json!({ "t": "done", "id": id })).map_err(io)?;
        let (ok, error) = ack_rx.recv_timeout(Duration::from_secs(120)).unwrap_or((false, "응답 없음".into()));
        sink(Event::Sent { id, ok, error: error.clone() });
        if ok { Ok(()) } else { Err(error) }
    }
}

struct Incoming {
    id: u32,
    name: String,
    size: u64,
    sha: String,
    part: PathBuf,
    file: File,
    hash: Sha256,
    got: u64,
    last: Instant,
    meta: Value,
}

/// 받은 파일 이름 정리: 경로 구분자·예약 문자 제거, 같은 이름이 있으면 " (2)" …
pub fn safe_name(dir: &Path, name: &str) -> PathBuf {
    let clean: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let clean = clean.trim_matches(|c| c == '.' || c == ' ').to_string();
    let clean = if clean.is_empty() { "file".to_string() } else { clean };
    let (stem, ext) = match clean.rfind('.') {
        Some(i) if i > 0 => (clean[..i].to_string(), clean[i..].to_string()),
        _ => (clean.clone(), String::new()),
    };
    let mut p = dir.join(&clean);
    let mut k = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({k}){ext}"));
        k += 1;
    }
    p
}

/// 핸드셰이크 + 페어링 + 수신 루프. 연결이 준비되면 on_conn 으로 Conn 을 넘긴다. 끊기면 반환.
pub fn run(stream: TcpStream, server: bool, cfg: &Config, sink: Sink, on_conn: &dyn Fn(Option<Arc<Conn>>)) -> std::io::Result<()> {
    stream.set_nodelay(true)?;
    let mut rd = BufReader::new(stream.try_clone()?);
    let mut wr = stream.try_clone()?;
    let eph = random32();
    let hello = json!({ "t": "hello", "v": VERSION, "name": cfg.name, "pk": hex(&public_of(&cfg.secret)), "eph": hex(&public_of(&eph)), "fp": cfg.engine_fp });
    write_frame(&mut wr, hello.to_string().as_bytes())?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let peer: Value = serde_json::from_slice(&read_frame(&mut rd)?).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    stream.set_read_timeout(None)?;
    let bad = || std::io::Error::new(std::io::ErrorKind::InvalidData, "bad hello");
    if peer["t"] != "hello" || peer["v"].as_u64() != Some(VERSION) {
        return Err(bad());
    }
    let (ppk, peph) = (unhex32(peer["pk"].as_str().unwrap_or("")).ok_or_else(bad)?, unhex32(peer["eph"].as_str().unwrap_or("")).ok_or_else(bad)?);
    let peer_name = peer["name"].as_str().unwrap_or("?").to_string();
    let peer_fp = peer["fp"].as_str().unwrap_or("").to_string();
    let k = derive(server, &cfg.secret, &eph, &ppk, &peph);
    let tx = Tx { stream: wr, aead: ChaCha20Poly1305::new(Key::from_slice(&k.send)), n: 0 };
    let closed = Arc::new(AtomicBool::new(false));
    stream.set_read_timeout(Some(Duration::from_millis(500)))?; // read_full 이 closed 를 보게
    let mut rx = Rx { stream: rd, aead: ChaCha20Poly1305::new(Key::from_slice(&k.recv)), n: 0, closed: closed.clone() };
    let known = cfg.known_peer == Some(ppk);
    let (ctx, crx) = channel();
    let conn = Arc::new(Conn {
        tx: Mutex::new(tx),
        peer_name: peer_name.clone(),
        peer_pk: ppk,
        ready: AtomicBool::new(false),
        next_id: AtomicU32::new(1),
        confirm: Mutex::new(Some(ctx)),
        acks: Mutex::new(vec![]),
        closed,
    });
    conn.json(json!({ "t": "state", "paired": known }))?;
    let (kind, body) = rx.recv()?;
    let st: Value = serde_json::from_slice(&body).unwrap_or_default();
    if kind != T_JSON || st["t"] != "state" {
        return Err(bad());
    }
    if !(cfg.accept_any || known && st["paired"] == true) {
        // 숫자 비교 페어링: 양쪽 화면의 코드가 같으면 사용자가 양쪽에서 확인 → pair-ok 교환
        on_conn(Some(conn.clone()));
        sink(Event::Peer { state: "pairing".into(), name: peer_name.clone(), code: k.code.clone() });
        let ok = crx.recv_timeout(Duration::from_secs(120)).unwrap_or(false);
        conn.json(json!({ "t": if ok { "pair-ok" } else { "pair-no" } }))?;
        let (kind, body) = rx.recv()?;
        let r: Value = serde_json::from_slice(&body).unwrap_or_default();
        if !ok || kind != T_JSON || r["t"] != "pair-ok" {
            sink(Event::Peer { state: "closed".into(), name: peer_name, code: String::new() });
            conn.close();
            return Ok(());
        }
        sink(Event::Paired { pk: hex(&ppk), name: peer_name.clone(), fp: peer_fp });
    }
    conn.ready.store(true, Ordering::Relaxed);
    on_conn(Some(conn.clone()));
    sink(Event::Peer { state: "ready".into(), name: peer_name.clone(), code: String::new() });
    let r = recv_loop(&mut rx, &conn, cfg, &sink);
    conn.ready.store(false, Ordering::Relaxed);
    conn.close(); // 남은 Arc 가 있어도 소켓은 닫는다 → 상대 쪽 읽기가 바로 끝남
    on_conn(None);
    sink(Event::Peer { state: "closed".into(), name: peer_name, code: String::new() });
    r
}

fn recv_loop(rx: &mut Rx, conn: &Arc<Conn>, cfg: &Config, sink: &Sink) -> std::io::Result<()> {
    let mut cur: Option<Incoming> = None;
    loop {
        let (kind, body) = match rx.recv() {
            Ok(m) => m,
            // 상대가 닫음 (정상 종료로 본다)
            Err(e) if matches!(e.kind(), std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted) => return Ok(()),
            Err(e) => return Err(e),
        };
        if kind == T_CHUNK {
            let Some(inc) = cur.as_mut().filter(|i| body.len() >= 4 && body[..4] == i.id.to_be_bytes()) else { continue };
            let data = &body[4..];
            inc.got += data.len() as u64;
            if inc.got > inc.size {
                cur = None; // 약속보다 크면 버림 (done 에서 실패 ack)
                continue;
            }
            inc.file.write_all(data)?;
            inc.hash.update(data);
            if inc.last.elapsed() > Duration::from_millis(100) || inc.got == inc.size {
                inc.last = Instant::now();
                sink(Event::Xfer { dir: "in".into(), id: inc.id, name: inc.name.clone(), bytes: inc.got, size: inc.size });
            }
            continue;
        }
        let m: Value = serde_json::from_slice(&body).unwrap_or_default();
        match m["t"].as_str().unwrap_or("") {
            "offer" => {
                std::fs::create_dir_all(&cfg.downloads)?;
                let id = m["id"].as_u64().unwrap_or(0) as u32;
                let name = m["name"].as_str().unwrap_or("file").to_string();
                let part = cfg.downloads.join(format!(".hera-{id}-{}.part", std::process::id()));
                cur = Some(Incoming {
                    id,
                    name,
                    size: m["size"].as_u64().unwrap_or(0),
                    sha: m["sha256"].as_str().unwrap_or("").to_lowercase(),
                    file: File::create(&part)?,
                    part,
                    hash: Sha256::new(),
                    got: 0,
                    last: Instant::now(),
                    meta: json!({ "via": m["via"], "edge": m["edge"], "pos": m["pos"], "cfid": m["cfid"] }), // cfid = Hera Team 채팅 파일
                });
            }
            "done" => {
                let id = m["id"].as_u64().unwrap_or(0) as u32;
                let Some(inc) = cur.take().filter(|i| i.id == id) else {
                    conn.json(json!({ "t": "ack", "id": id, "ok": false, "error": "unknown transfer" }))?;
                    continue;
                };
                drop(inc.file);
                let ok = inc.got == inc.size && hex(&inc.hash.finalize()) == inc.sha;
                if ok {
                    let dest = safe_name(&cfg.downloads, &inc.name);
                    std::fs::rename(&inc.part, &dest)?;
                    sink(Event::Received { id, path: dest.display().to_string(), meta: inc.meta });
                    conn.json(json!({ "t": "ack", "id": id, "ok": true }))?;
                } else {
                    let _ = std::fs::remove_file(&inc.part);
                    conn.json(json!({ "t": "ack", "id": id, "ok": false, "error": "hash mismatch" }))?;
                }
            }
            "ack" => {
                let id = m["id"].as_u64().unwrap_or(0) as u32;
                let mut acks = conn.acks.lock().unwrap();
                if let Some(i) = acks.iter().position(|(a, _)| *a == id) {
                    let (_, tx) = acks.remove(i);
                    let _ = tx.send((m["ok"] == true, m["error"].as_str().unwrap_or("").to_string()));
                }
            }
            "clip" => sink(Event::Clip { text: m["text"].as_str().unwrap_or("").chars().take(64 * 1024).collect() }),
            "ping" => {}
            "bye" => return Ok(()), // 상대가 닫음
            _ => sink(Event::Msg { msg: m }), // 위층이 처리 (모르면 무시)
        }
    }
}

/* ── 발견: 윈도우가 3초마다 UDP 브로드캐스트 {"hera":1,"name","port"}. 맥은 듣다가 보낸 주소:port 로 접속 ── */
pub fn beacon(name: &str, port: u16, stop: &AtomicBool, busy: &dyn Fn() -> bool) {
    let Ok(sock) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) else { return };
    let _ = sock.set_broadcast(true);
    let msg = json!({ "hera": VERSION, "name": name, "port": port }).to_string();
    while !stop.load(Ordering::Relaxed) {
        if !busy() {
            let _ = sock.send_to(msg.as_bytes(), (Ipv4Addr::BROADCAST, BEACON_PORT));
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// 맥(클라이언트) 쪽: 비콘 1개를 기다려 서버 주소를 돌려준다 (윈도우 빌드에선 안 씀)
#[allow(dead_code)] // 맥 포트(클라이언트)에서 사용
pub fn discover(timeout: Duration) -> Option<(SocketAddr, String)> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, BEACON_PORT)).ok()?;
    sock.set_read_timeout(Some(timeout)).ok()?;
    let mut buf = [0u8; 512];
    let (n, from) = sock.recv_from(&mut buf).ok()?;
    let v: Value = serde_json::from_slice(&buf[..n]).ok()?;
    if v["hera"].as_u64() != Some(VERSION) {
        return None;
    }
    Some((SocketAddr::new(from.ip(), v["port"].as_u64()? as u16), v["name"].as_str().unwrap_or("").to_string()))
}

/// 서버(윈도우): 대기하다 접속 1개씩 처리. 새 접속이 오면 이전 연결은 닫는다. stop 이 서면 다음 접속 시도 때 끝.
pub fn serve(listener: TcpListener, cfg: Arc<dyn Fn() -> Config + Send + Sync>, sink: Sink, on_conn: Arc<dyn Fn(Option<Arc<Conn>>) + Send + Sync>, stop: Arc<AtomicBool>) {
    for s in listener.incoming() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let Ok(s) = s else { continue };
        let (cfg, sink, on_conn) = (cfg.clone(), sink.clone(), on_conn.clone());
        std::thread::spawn(move || {
            if let Err(e) = run(s, true, &cfg(), sink, &*on_conn) {
                eprintln!("link: {e}");
            }
        });
    }
}

/// 맥(클라이언트)·테스트: 접속해서 run (윈도우 빌드에선 안 씀)
#[allow(dead_code)] // 맥 포트(클라이언트)에서 사용
pub fn connect(addr: SocketAddr, cfg: &Config, sink: Sink, on_conn: &dyn Fn(Option<Arc<Conn>>)) -> std::io::Result<()> {
    run(TcpStream::connect_timeout(&addr, Duration::from_secs(5))?, false, cfg, sink, on_conn)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::type_complexity)]
    use super::*;

    #[test]
    fn frames_and_keys() {
        let mut buf = vec![];
        write_frame(&mut buf, b"hello").unwrap();
        write_frame(&mut buf, b"").unwrap();
        let mut r = buf.as_slice();
        assert_eq!(read_frame(&mut r).unwrap(), b"hello");
        assert_eq!(read_frame(&mut r).unwrap(), b"");
        let mut big = (MAX_FRAME as u32 + 1).to_be_bytes().to_vec();
        big.extend([0; 8]);
        assert!(read_frame(&mut big.as_slice()).is_err());
        // 양쪽 키 유도가 맞물리는가 + 코드 일치, 다른 정적 키면 코드가 달라진다(중간자 탐지)
        let (cs, ce, ss, se) = (random32(), random32(), random32(), random32());
        let c = derive(false, &cs, &ce, &public_of(&ss), &public_of(&se));
        let s = derive(true, &ss, &se, &public_of(&cs), &public_of(&ce));
        assert_eq!((c.send, c.recv, &c.code), (s.recv, s.send, &s.code));
        assert_eq!(c.code.len(), 6);
        let m = derive(true, &random32(), &se, &public_of(&cs), &public_of(&ce));
        assert_ne!(m.code, c.code);
        assert_eq!(unhex32(&hex(&cs)), Some(cs));
    }

    #[test]
    fn names() {
        let d = std::env::temp_dir().join(format!("hera-names-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(safe_name(&d, "../../a:b?.txt").file_name().unwrap(), "_.._a_b_.txt");
        std::fs::write(d.join("x.txt"), b"").unwrap();
        assert_eq!(safe_name(&d, "x.txt").file_name().unwrap(), "x (2).txt");
        assert_eq!(safe_name(&d, "...").file_name().unwrap(), "file");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 수동(실행 중인 Hera 상대, .omc/verify/link-cdp.mjs 가 사용): 맥 역할로 접속 → 자동 확인 → 파일 1개 보내고 ack 확인.
    /// HERA_LINK_ADDR=127.0.0.1:24810 HERA_LINK_FILE=<경로> cargo test --lib live_peer -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_peer() {
        let addr: SocketAddr = std::env::var("HERA_LINK_ADDR").unwrap_or("127.0.0.1:24810".into()).parse().unwrap();
        let file = PathBuf::from(std::env::var("HERA_LINK_FILE").expect("HERA_LINK_FILE"));
        let cfg = Config { name: "TestMac".into(), secret: random32(), known_peer: None, engine_fp: String::new(), downloads: std::env::temp_dir().join("hera-live-peer"), accept_any: false };
        let sink: Sink = Arc::new(|e| println!("EVENT {}", serde_json::to_string(&e).unwrap()));
        let done = Arc::new(AtomicBool::new(false));
        let d = done.clone();
        let s2 = sink.clone();
        connect(addr, &cfg, sink, &move |c| {
            let Some(c) = c else { return };
            if !c.is_ready() {
                c.confirm(true); // 맥 쪽 '같아요' (Hera 쪽은 CDP 가 link_pair(true))
                return;
            }
            if d.swap(true, Ordering::Relaxed) {
                return;
            }
            let (c, s, f) = (c.clone(), s2.clone(), file.clone());
            std::thread::spawn(move || {
                // 3b 메시지: 맥 모니터 · 할 일 동기화 · 상대 화면 효과 · 가장자리로 보낸 파일
                let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
                let _ = c.send(json!({ "t": "monitors", "list": [{ "id": "TestMac A", "rect": [0, 0, 1512, 982], "scale": 2.0, "primary": true }, { "id": "TestMac B", "rect": [1512, 0, 1920, 1080], "scale": 1.0, "primary": false }] }));
                let _ = c.send(json!({ "t": "sync", "items": [{ "key": "todo:hera-live-test", "value": { "id": "hera-live-test", "title": "맥에서 온 할 일", "done": false, "source": "local" }, "at": at, "scope": "personal" }] }));
                let _ = c.send(json!({ "t": "ambient", "kind": "fx", "fx": "moon", "action": "start" }));
                println!("SEND {:?}", c.send_file_meta(&f, &s, json!({ "via": "edge", "edge": "left", "pos": 0.5 })));
                std::thread::sleep(Duration::from_millis(800));
                c.close();
            });
        })
        .unwrap();
        assert!(done.load(Ordering::Relaxed), "never became ready");
    }

    /// 두 끝점(루프백): 처음엔 페어링(양쪽 같은 코드 → 확인) → 파일 전송 → 해시 확인 → 클립 → 재접속은 페어링 없이
    #[test]
    fn loopback_pair_and_transfer() {
        let base = std::env::temp_dir().join(format!("hera-link-{}", std::process::id()));
        let (win_dl, mac_dl) = (base.join("win"), base.join("mac"));
        let (win_sk, mac_sk) = (random32(), random32());
        let src = base.join("photo.bin");
        std::fs::create_dir_all(&base).unwrap();
        let data: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
        std::fs::write(&src, &data).unwrap();

        let events: Arc<Mutex<Vec<(char, Event)>>> = Arc::new(Mutex::new(vec![]));
        let sink_for = |tag: char| -> Sink {
            let ev = events.clone();
            Arc::new(move |e| ev.lock().unwrap().push((tag, e)))
        };
        let conns: Arc<Mutex<Vec<(char, Arc<Conn>)>>> = Arc::new(Mutex::new(vec![]));
        let session = |known: bool| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let (sk1, dl1, sink1, c1) = (win_sk, win_dl.clone(), sink_for('w'), conns.clone());
            let mac_pk = public_of(&mac_sk);
            let server = std::thread::spawn(move || {
                let (s, _) = listener.accept().unwrap();
                let cfg = Config { name: "WIN".into(), secret: sk1, known_peer: known.then_some(mac_pk), engine_fp: "aa".into(), downloads: dl1, accept_any: false };
                run(s, true, &cfg, sink1, &move |c| if let Some(c) = c { c1.lock().unwrap().push(('w', c)) }).unwrap();
            });
            let (dl2, sink2, c2) = (mac_dl.clone(), sink_for('m'), conns.clone());
            let win_pk = public_of(&win_sk);
            let client = std::thread::spawn(move || {
                let cfg = Config { name: "MAC".into(), secret: mac_sk, known_peer: known.then_some(win_pk), engine_fp: "bb".into(), downloads: dl2, accept_any: false };
                connect(addr, &cfg, sink2, &move |c| if let Some(c) = c { c2.lock().unwrap().push(('m', c)) }).unwrap();
            });
            (server, client)
        };
        let wait_for = |f: &dyn Fn(&[(char, Event)]) -> bool| {
            for _ in 0..200 {
                if f(&events.lock().unwrap()) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            false
        };

        // 1) 처음: 페어링
        let (s, c) = session(false);
        assert!(wait_for(&|e| e.iter().filter(|(_, e)| matches!(e, Event::Peer { state, .. } if state == "pairing")).count() == 2));
        let codes: Vec<String> = events.lock().unwrap().iter().filter_map(|(_, e)| if let Event::Peer { code, state, .. } = e { (state == "pairing").then(|| code.clone()) } else { None }).collect();
        assert_eq!(codes[0], codes[1], "양쪽 코드가 같아야 함");
        for (_, c) in conns.lock().unwrap().iter() {
            c.confirm(true);
        }
        assert!(wait_for(&|e| e.iter().filter(|(_, e)| matches!(e, Event::Peer { state, .. } if state == "ready")).count() == 2));
        assert!(events.lock().unwrap().iter().any(|(t, e)| *t == 'w' && matches!(e, Event::Paired { fp, name, .. } if fp == "bb" && name == "MAC")));

        // 2) 맥 → 윈도우 파일
        let mac = conns.lock().unwrap().iter().rev().find(|(t, c)| *t == 'm' && c.is_ready()).unwrap().1.clone();
        mac.send_file_meta(&src, &sink_for('m'), json!({ "via": "edge", "edge": "left", "pos": 0.25 })).unwrap();
        assert!(events.lock().unwrap().iter().any(|(t, e)| *t == 'w' && matches!(e, Event::Received { meta, .. } if meta["via"] == "edge" && meta["pos"] == 0.25)));
        mac.send(json!({ "t": "ambient", "kind": "fx", "fx": "snow", "action": "start" })).unwrap();
        assert!(wait_for(&|e| e.iter().any(|(t, e)| *t == 'w' && matches!(e, Event::Msg { msg } if msg["t"] == "ambient" && msg["fx"] == "snow"))));
        let got = events.lock().unwrap().iter().find_map(|(t, e)| if let (&'w', Event::Received { path, .. }) = (t, e) { Some(path.clone()) } else { None }).unwrap();
        assert_eq!(std::fs::read(&got).unwrap(), data);
        assert!(got.ends_with("photo.bin"));
        assert!(events.lock().unwrap().iter().any(|(t, e)| *t == 'm' && matches!(e, Event::Sent { ok: true, .. })));
        // 3) 클립보드 기록 항목
        mac.send_clip("안녕 hera").unwrap();
        assert!(wait_for(&|e| e.iter().any(|(t, e)| *t == 'w' && matches!(e, Event::Clip { text } if text == "안녕 hera"))));
        mac.close();
        s.join().unwrap();
        c.join().unwrap();

        // 4) 재접속: 서로 아는 키 → 페어링 없이 바로 ready
        events.lock().unwrap().clear();
        conns.lock().unwrap().clear();
        let (s, c) = session(true);
        assert!(wait_for(&|e| e.iter().filter(|(_, e)| matches!(e, Event::Peer { state, .. } if state == "ready")).count() == 2));
        assert!(!events.lock().unwrap().iter().any(|(_, e)| matches!(e, Event::Peer { state, .. } if state == "pairing")));
        let win = conns.lock().unwrap().iter().find(|(t, _)| *t == 'w').unwrap().1.clone();
        win.send_file(&src, &sink_for('w')).unwrap(); // 윈도우 → 맥
        let got = events.lock().unwrap().iter().find_map(|(t, e)| if let (&'m', Event::Received { path, .. }) = (t, e) { Some(path.clone()) } else { None }).unwrap();
        assert_eq!(std::fs::read(&got).unwrap(), data);
        win.close();
        s.join().unwrap();
        c.join().unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }
}
