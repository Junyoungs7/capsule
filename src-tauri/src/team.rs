// Hera Team: 같은 사내망의 동료 PC 들과 그룹 단위로 일정(event:)·메모(note:)만 공유 (.omc/plans/hera-team.md).
// 서버 없음. 전송·암호는 Hera Link 파일 채널(link_files: X25519+HKDF+ChaCha20-Poly1305)을 그대로, 포트·비콘만 따로 (24820 / UDP 24821).
// 신원: 각 PC 의 장기 공개키. 그룹 = 그룹원 공개키 목록. 들어오기 = 그룹원이 만든 6자리 초대 코드(10분, 5번 틀리면 폐기).
// 동기화 = link_sync (항목마다 최종 수정 우선 + 묘비, scope = group:<id>). 온라인 그룹원이 새로 받은 항목을 다른 그룹원에게 전달(릴레이).
// 개인 항목(그룹 필드 없음)은 절대 보내지 않는다 — 보낼 때도 받을 때도 그 그룹의 그룹원인지 확인.
use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::link_files::{self as lf, Conn};
use crate::link_sync as ls;

pub const PORT: u16 = 24820;
pub const BEACON_PORT: u16 = 24821;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Member {
    pub pk: String, // hex
    pub name: String,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
    pub members: Vec<Member>,
    /// 그룹 정보가 바뀐 시각 (그룹원 추가 등) — 더 새것이 이김
    pub rev: i64,
    #[serde(default = "yes")]
    pub alarms: bool,
    #[serde(default = "yes")]
    pub news: bool,
}

fn yes() -> bool {
    true
}

impl Group {
    fn has(&self, pk: &str) -> bool {
        self.members.iter().any(|m| m.pk == pk)
    }
}

/// 위층(Tauri 연결 코드·시험)으로 가는 알림
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TeamEv {
    /// 그룹원이 바꾼 항목을 적용함 → store 에 쓰기 + Island 변경 소식
    Applied { group: String, key: String, value: Option<Value>, by: String, action: String },
    /// 그룹 목록·그룹원 변경 → store `team.group:<id>`
    Group { group: Group },
    /// 연결 상태 (그룹원 이름)
    Online { pk: String, name: String, online: bool },
    /// 들어오기 결과
    Joined { group: String, ok: bool, error: String },
}

pub type TeamSink = Arc<dyn Fn(TeamEv) + Send + Sync>;

struct Invite {
    group: String,
    code: String,
    until: Instant,
    tries: u32,
}

pub struct Node {
    pub name: String,
    secret: [u8; 32],
    pub pk: String,
    groups: Mutex<Vec<Group>>,
    items: Mutex<HashMap<String, Value>>, // 그룹 항목만 (키 → 값)
    meta: Mutex<ls::Meta>,
    conns: Mutex<Vec<Arc<Conn>>>,
    invites: Mutex<Vec<Invite>>,
    sink: TeamSink,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn group_of(v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v["group"].as_str()).filter(|g| !g.is_empty()).map(String::from)
}

/// 초대 문자열: 코드 + 주소 + 그룹 이름 (base16 JSON — 복사해 붙이기 쉬운 한 줄)
pub fn invite_string(code: &str, addrs: &[String], group_name: &str) -> String {
    format!("hera-team:{}", lf::hex(json!({ "c": code, "a": addrs, "n": group_name }).to_string().as_bytes()))
}

pub fn parse_invite(s: &str) -> Option<(String, Vec<String>, String)> {
    let h = s.trim().strip_prefix("hera-team:")?;
    let bytes: Vec<u8> = (0..h.len()).step_by(2).map(|i| u8::from_str_radix(h.get(i..i + 2)?, 16).ok()).collect::<Option<_>>()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    Some((v["c"].as_str()?.to_string(), v["a"].as_array()?.iter().filter_map(|a| a.as_str().map(String::from)).collect(), v["n"].as_str().unwrap_or("").to_string()))
}

impl Node {
    pub fn new(name: &str, secret: [u8; 32], groups: Vec<Group>, items: HashMap<String, Value>, meta: ls::Meta, sink: TeamSink) -> Arc<Node> {
        Arc::new(Node {
            name: name.into(),
            pk: lf::hex(&lf::public_of(&secret)),
            secret,
            groups: Mutex::new(groups),
            items: Mutex::new(items),
            meta: Mutex::new(meta),
            conns: Mutex::new(vec![]),
            invites: Mutex::new(vec![]),
            sink,
        })
    }

    pub fn groups(&self) -> Vec<Group> {
        self.groups.lock().unwrap().clone()
    }

    #[cfg_attr(not(test), allow(dead_code))] // 시험·디버그용
    pub fn item(&self, key: &str) -> Option<Value> {
        self.items.lock().unwrap().get(key).cloned()
    }

    pub fn has_open_invite(&self) -> bool {
        self.invites.lock().unwrap().iter().any(|i| i.until > Instant::now())
    }

    fn cfg(&self) -> lf::Config {
        lf::Config { name: self.name.clone(), secret: self.secret, known_peer: None, engine_fp: String::new(), downloads: std::env::temp_dir(), accept_any: true }
    }

    /// 새 그룹 (나만 그룹원)
    pub fn create_group(&self, name: &str, color: &str) -> Group {
        let g = Group { id: format!("g{}", &lf::hex(&lf::random32())[..12]), name: name.into(), color: color.into(), members: vec![Member { pk: self.pk.clone(), name: self.name.clone() }], rev: now_ms(), alarms: true, news: true };
        self.groups.lock().unwrap().push(g.clone());
        (self.sink)(TeamEv::Group { group: g.clone() });
        g
    }

    /// 6자리 초대 코드 (10분)
    pub fn invite(&self, group: &str) -> Option<String> {
        if !self.groups.lock().unwrap().iter().any(|g| g.id == group) {
            return None;
        }
        let r = lf::random32();
        let code = format!("{:06}", u32::from_be_bytes([r[0], r[1], r[2], r[3]]) % 1_000_000);
        let mut inv = self.invites.lock().unwrap();
        inv.retain(|i| i.until > Instant::now());
        inv.push(Invite { group: group.into(), code: code.clone(), until: Instant::now() + Duration::from_secs(600), tries: 0 });
        Some(code)
    }

    fn send_to(&self, group: &str, v: &Value, except: Option<&[u8; 32]>) {
        let g = self.groups.lock().unwrap().iter().find(|g| g.id == group).cloned();
        let Some(g) = g else { return };
        for c in self.conns.lock().unwrap().iter() {
            if c.is_ready() && Some(&c.peer_pk) != except && g.has(&lf::hex(&c.peer_pk)) {
                let _ = c.send(v.clone());
            }
        }
    }

    /// 이 PC 에서 바뀐 항목 (store 변경) → 그룹 항목이면 메타 갱신 + 그룹원에게
    pub fn local_change(&self, key: &str, value: Option<Value>) {
        if !ls::team_syncable(key) {
            return;
        }
        // 지울 때는 지우기 전 값의 그룹을 쓴다
        let group = group_of(value.as_ref()).or_else(|| group_of(self.items.lock().unwrap().get(key)));
        let Some(group) = group else { return }; // 개인 항목: 아무 데도 안 보냄
        if !self.groups.lock().unwrap().iter().any(|g| g.id == group) {
            return;
        }
        let at = now_ms();
        {
            let mut items = self.items.lock().unwrap();
            match &value {
                Some(v) => items.insert(key.into(), v.clone()),
                None => items.remove(key),
            };
        }
        self.meta.lock().unwrap().insert(key.into(), (at, value.is_none()));
        let item = ls::Item { key: key.into(), value, at, scope: format!("group:{group}") };
        self.send_to(&group, &json!({ "t": "tsync", "group": group, "items": [item], "by": self.name }), None);
    }

    fn snapshot(&self, group: &str) -> Vec<ls::Item> {
        let scope = format!("group:{group}");
        let live: Vec<(String, Value)> = self.items.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let meta = self.meta.lock().unwrap();
        let mut v = ls::snapshot(&meta, &live, |s| s == scope);
        // 묘비는 그룹을 모르면 보낼 수 없다 → 이 그룹 항목이었던 묘비만 (값이 없으니 scope 기록이 필요 — 여기선 키 접두로 그룹 기억)
        v.retain(|i| i.value.is_some() || self.tomb_group(&i.key).as_deref() == Some(group));
        for i in v.iter_mut().filter(|i| i.value.is_none()) {
            i.scope = scope.clone();
        }
        v
    }

    fn tomb_group(&self, key: &str) -> Option<String> {
        self.items.lock().unwrap().get(&format!("tomb:{key}")).and_then(|v| v.as_str().map(String::from))
    }

    fn apply(&self, group: &str, items: Vec<ls::Item>, from: &[u8; 32], by: &str) {
        let scope = format!("group:{group}");
        let todo = {
            let mut meta = self.meta.lock().unwrap();
            let t = ls::merge(&meta, &items, |s| s == scope);
            // 값 안의 group 이 메시지 그룹과 다르면(다른 그룹·개인으로 위장) 버린다
            let t: Vec<ls::Item> = t.into_iter().filter(|i| i.value.as_ref().is_none_or(|v| group_of(Some(v)).as_deref() == Some(group))).collect();
            for i in &t {
                meta.insert(i.key.clone(), (i.at, i.value.is_none()));
            }
            t
        };
        if todo.is_empty() {
            return;
        }
        {
            let mut it = self.items.lock().unwrap();
            for i in &todo {
                match &i.value {
                    Some(v) => {
                        it.insert(i.key.clone(), v.clone());
                    }
                    None => {
                        it.remove(&i.key);
                        it.insert(format!("tomb:{}", i.key), json!(group));
                    }
                }
            }
        }
        for i in &todo {
            let action = if i.value.is_none() { "delete" } else { "change" };
            let who = i.value.as_ref().and_then(|v| v["by"].as_str()).unwrap_or(by).to_string();
            (self.sink)(TeamEv::Applied { group: group.into(), key: i.key.clone(), value: i.value.clone(), by: who, action: action.into() });
        }
        // 릴레이: 새로 받은 것만 다른 그룹원에게 (이미 가진 쪽은 merge 에서 걸러져 멈춘다)
        self.send_to(group, &json!({ "t": "tsync", "group": group, "items": todo, "by": by }), Some(from));
    }

    fn update_group(&self, g: Group, from: Option<&[u8; 32]>) {
        let mut changed = false;
        {
            let mut gs = self.groups.lock().unwrap();
            match gs.iter_mut().find(|x| x.id == g.id) {
                Some(cur) if g.rev > cur.rev && from.is_none_or(|f| cur.has(&lf::hex(f))) => {
                    let (alarms, news) = (cur.alarms, cur.news); // 알림 켜기/끄기는 내 설정
                    *cur = Group { alarms, news, ..g.clone() };
                    changed = true;
                }
                None if g.has(&self.pk) => {
                    gs.push(g.clone());
                    changed = true;
                }
                _ => {}
            }
        }
        if changed {
            let cur = self.groups.lock().unwrap().iter().find(|x| x.id == g.id).cloned().unwrap();
            (self.sink)(TeamEv::Group { group: cur.clone() });
            self.send_to(&g.id, &json!({ "t": "tgroup", "group": cur }), from);
        }
    }

    pub fn set_group_flags(&self, group: &str, alarms: bool, news: bool) {
        if let Some(g) = self.groups.lock().unwrap().iter_mut().find(|g| g.id == group) {
            g.alarms = alarms;
            g.news = news;
        }
    }

    fn conn_of(&self, name_pk: &str) -> Option<Arc<Conn>> {
        self.conns.lock().unwrap().iter().find(|c| lf::hex(&c.peer_pk) == name_pk).cloned()
    }

    /// 연결별 메시지 처리 (from = 그 연결의 상대 공개키)
    fn handle(&self, from: &[u8; 32], from_name: &str, msg: &Value) {
        let pk = lf::hex(from);
        let member_of = |g: &str| self.groups.lock().unwrap().iter().any(|x| x.id == g && x.has(&pk));
        match msg["t"].as_str().unwrap_or("") {
            "join" => {
                let code = msg["code"].as_str().unwrap_or("");
                let name = msg["name"].as_str().unwrap_or(from_name).to_string();
                let gid = {
                    let mut inv = self.invites.lock().unwrap();
                    inv.retain(|i| i.until > Instant::now() && i.tries < 5);
                    let hit = inv.iter().position(|i| i.code == code);
                    match hit {
                        Some(i) => Some(inv.remove(i).group),
                        None => {
                            inv.iter_mut().for_each(|i| i.tries += 1); // 틀린 시도는 모든 열린 초대에 셈 (무차별 대입 방지)
                            None
                        }
                    }
                };
                let c = self.conn_of(&pk);
                let Some(gid) = gid else {
                    if let Some(c) = c {
                        let _ = c.send(json!({ "t": "join-no", "error": "초대 코드가 맞지 않거나 만료됐어요" }));
                    }
                    return;
                };
                let g = {
                    let mut gs = self.groups.lock().unwrap();
                    let Some(g) = gs.iter_mut().find(|g| g.id == gid) else { return };
                    if !g.has(&pk) {
                        g.members.push(Member { pk: pk.clone(), name });
                        g.rev = now_ms();
                    }
                    g.clone()
                };
                (self.sink)(TeamEv::Group { group: g.clone() });
                // 새 그룹원 포함 모두에게 그룹 정보, 새 그룹원에게 전체 항목
                self.send_to(&gid, &json!({ "t": "tgroup", "group": g }), None);
                if let Some(c) = self.conn_of(&pk) {
                    let _ = c.send(json!({ "t": "tsync", "group": gid, "items": self.snapshot(&gid), "by": self.name }));
                }
            }
            "join-no" => (self.sink)(TeamEv::Joined { group: String::new(), ok: false, error: msg["error"].as_str().unwrap_or("").into() }),
            "tgroup" => {
                let Ok(g) = serde_json::from_value::<Group>(msg["group"].clone()) else { return };
                // 보낸 쪽이 그 그룹원이어야 한다 (처음 받는 그룹은 새 목록에 나와 보낸 쪽이 모두 있어야)
                if !g.has(&pk) {
                    return;
                }
                let first = !self.groups.lock().unwrap().iter().any(|x| x.id == g.id);
                self.update_group(g.clone(), Some(from));
                if first && g.has(&self.pk) {
                    (self.sink)(TeamEv::Joined { group: g.id.clone(), ok: true, error: String::new() });
                }
            }
            "tsync" => {
                let group = msg["group"].as_str().unwrap_or("").to_string();
                if !member_of(&group) {
                    return; // 그룹원 아님 → 무시
                }
                let Ok(items) = serde_json::from_value::<Vec<ls::Item>>(msg["items"].clone()) else { return };
                self.apply(&group, items, from, msg["by"].as_str().unwrap_or(from_name));
            }
            _ => {}
        }
    }

    /// 연결 1개 (실제 진입점): link_files 의 sink 를 이 연결 전용으로 만들어 보낸 쪽을 안다
    pub fn run_conn(self: &Arc<Self>, stream: TcpStream, server: bool, join_code: Option<String>) {
        let me = self.clone();
        type Peer = Option<([u8; 32], String)>; // 이 연결의 상대 (공개키, 이름)
        let peer: Arc<Mutex<Peer>> = Arc::new(Mutex::new(None));
        let p2 = peer.clone();
        let me2 = self.clone();
        let sink: lf::Sink = Arc::new(move |e: lf::Event| {
            if let lf::Event::Msg { msg } = e {
                if let Some((pk, name)) = p2.lock().unwrap().clone() {
                    me2.handle(&pk, &name, &msg);
                }
            }
        });
        let code = join_code;
        let on_conn = move |c: Option<Arc<Conn>>| {
            let Some(c) = c else { return };
            if !c.is_ready() {
                return;
            }
            *peer.lock().unwrap() = Some((c.peer_pk, c.peer_name.clone()));
            me.conns.lock().unwrap().push(c.clone());
            let pk = lf::hex(&c.peer_pk);
            (me.sink)(TeamEv::Online { pk: pk.clone(), name: c.peer_name.clone(), online: true });
            if let Some(code) = &code {
                let _ = c.send(json!({ "t": "join", "code": code, "name": me.name }));
            }
            for g in me.groups().into_iter().filter(|g| g.has(&pk)) {
                let _ = c.send(json!({ "t": "tgroup", "group": g }));
                let _ = c.send(json!({ "t": "tsync", "group": g.id, "items": me.snapshot(&g.id), "by": me.name }));
            }
        };
        let _ = lf::run(stream, server, &self.cfg(), sink, &on_conn);
        let mut cs = self.conns.lock().unwrap();
        let gone: Vec<Arc<Conn>> = cs.iter().filter(|c| !c.is_ready()).cloned().collect();
        cs.retain(|c| c.is_ready());
        drop(cs);
        for c in gone {
            (self.sink)(TeamEv::Online { pk: lf::hex(&c.peer_pk), name: c.peer_name.clone(), online: false });
        }
    }

    /// 대기 (서버): 접속마다 스레드
    pub fn serve(self: &Arc<Self>, listener: TcpListener) {
        for s in listener.incoming().flatten() {
            let me = self.clone();
            std::thread::spawn(move || me.run_conn(s, true, None));
        }
    }

    /// 접속 (그룹원에게, 또는 초대 코드로 들어오기)
    pub fn connect(self: &Arc<Self>, addr: SocketAddr, join_code: Option<String>) -> std::io::Result<()> {
        let s = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
        let me = self.clone();
        std::thread::spawn(move || me.run_conn(s, false, join_code));
        Ok(())
    }

    /// 그룹원 공개키로 이미 연결돼 있나 (비콘 중복 접속 방지)
    pub fn connected_to(&self, pk: &str) -> bool {
        self.conns.lock().unwrap().iter().any(|c| c.is_ready() && lf::hex(&c.peer_pk) == pk)
    }

    /// 비콘을 받았을 때 접속할 상대인가: 같은 그룹원 + 아직 연결 안 됨 + 공개키가 내 것보다 큼(양쪽이 동시에 걸지 않게)
    pub fn should_dial(&self, pk: &str) -> bool {
        pk > self.pk.as_str() && !self.connected_to(pk) && self.groups.lock().unwrap().iter().any(|g| g.has(pk))
    }

    #[cfg_attr(not(test), allow(dead_code))] // 시험 정리용
    pub fn close_all(&self) {
        for c in self.conns.lock().unwrap().drain(..) {
            c.close();
        }
    }
}

/* ── Tauri 연결: store · 이벤트 · 명령 (그룹이 있을 때만 포트를 연다) ── */
pub mod app {
    use super::*;
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};
    use tauri_plugin_store::StoreExt;

    static NODE: OnceLock<Arc<Node>> = OnceLock::new();
    static APPLYING: Mutex<Vec<(String, Option<Value>)>> = Mutex::new(Vec::new());
    static SERVING: OnceLock<()> = OnceLock::new();
    static LISTENING: OnceLock<()> = OnceLock::new();
    /// 비콘으로 본 '초대 열림' 호스트 (코드만으로 들어오기)
    static HOSTS: Mutex<Vec<SocketAddr>> = Mutex::new(Vec::new());

    fn store(app: &AppHandle) -> Option<Arc<tauri_plugin_store::Store<tauri::Wry>>> {
        app.store("hera.json").ok()
    }

    fn my_name(app: &AppHandle) -> String {
        store(app).and_then(|s| s.get("team.name")).and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "나".into()))
    }

    pub fn node(app: &AppHandle) -> Arc<Node> {
        NODE.get_or_init(|| {
            let s = store(app);
            let get = |k: &str| s.as_ref().and_then(|s| s.get(k));
            let secret = get("team.key").and_then(|v| v.as_str().and_then(lf::unhex32)).unwrap_or_else(|| {
                let k = lf::random32();
                if let Some(s) = &s {
                    s.set("team.key", lf::hex(&k)); // Hera Link 키와 따로
                }
                k
            });
            let entries = s.as_ref().map(|s| s.entries()).unwrap_or_default();
            let groups: Vec<Group> = entries.iter().filter(|(k, _)| k.starts_with("team.group:")).filter_map(|(_, v)| serde_json::from_value(v.clone()).ok()).collect();
            let items: HashMap<String, Value> = entries.iter().filter(|(k, v)| ls::team_syncable(k) && group_of(Some(v)).is_some()).map(|(k, v)| (k.clone(), v.clone())).collect();
            let meta: ls::Meta = get("team.meta").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
            let a = app.clone();
            Node::new(&my_name(app), secret, groups, items, meta, Arc::new(move |e| on_team(&a, e)))
        })
        .clone()
    }

    fn persist_meta(app: &AppHandle) {
        if let (Some(n), Some(s)) = (NODE.get(), store(app)) {
            s.set("team.meta", serde_json::to_value(&*n.meta.lock().unwrap()).unwrap_or(Value::Null));
        }
    }

    fn on_team(app: &AppHandle, e: TeamEv) {
        match &e {
            TeamEv::Applied { group, key, value, by, action } => {
                if let Some(s) = store(app) {
                    APPLYING.lock().unwrap().push((key.clone(), value.clone()));
                    match value {
                        Some(v) => s.set(key.clone(), v.clone()),
                        None => {
                            s.delete(key);
                        }
                    }
                }
                persist_meta(app);
                let news = NODE.get().and_then(|n| n.groups().into_iter().find(|g| &g.id == group)).is_none_or(|g| g.news);
                if news {
                    let title = value.as_ref().and_then(|v| v["title"].as_str().or(v["text"].as_str())).unwrap_or("").lines().next().unwrap_or("").to_string();
                    let _ = app.emit_to("island", "team-news", json!({ "group": group, "by": by, "action": action, "key": key, "title": title }));
                }
            }
            TeamEv::Group { group } => {
                if let Some(s) = store(app) {
                    s.set(format!("team.group:{}", group.id), serde_json::to_value(group).unwrap_or(Value::Null));
                }
                let a = app.clone();
                std::thread::spawn(move || serve(&a));
            }
            _ => {}
        }
        let _ = app.emit("team", &e);
    }

    /// 포트 열기 + 비콘 (그룹이 생기거나 들어올 때 1번)
    pub fn serve(app: &AppHandle) {
        let n = node(app);
        if n.groups().is_empty() || SERVING.set(()).is_err() {
            return;
        }
        if let Ok(l) = TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, PORT)) {
            let n2 = n.clone();
            std::thread::spawn(move || n2.serve(l));
        }
        let n2 = n.clone();
        std::thread::spawn(move || beacon(n2));
        start_listen(&n);
    }

    fn start_listen(n: &Arc<Node>) {
        if LISTENING.set(()).is_ok() {
            let n = n.clone();
            std::thread::spawn(move || listen(n));
        }
    }

    fn beacon(n: Arc<Node>) {
        let Ok(sock) = std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, 0)) else { return };
        let _ = sock.set_broadcast(true);
        loop {
            let msg = json!({ "hera-team": 1, "pk": n.pk, "port": PORT, "inv": n.has_open_invite() }).to_string();
            let _ = sock.send_to(msg.as_bytes(), (std::net::Ipv4Addr::BROADCAST, BEACON_PORT));
            std::thread::sleep(Duration::from_secs(5));
        }
    }

    /// 비콘 듣기: 그룹원이면 접속 (공개키 큰 쪽이 걸어 중복 없음), 초대 열린 호스트는 기억
    fn listen(n: Arc<Node>) {
        let Ok(sock) = std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, BEACON_PORT)) else { return };
        let mut buf = [0u8; 512];
        while let Ok((len, from)) = sock.recv_from(&mut buf) {
            let Ok(v) = serde_json::from_slice::<Value>(&buf[..len]) else { continue };
            let (Some(pk), Some(port)) = (v["pk"].as_str(), v["port"].as_u64()) else { continue };
            if pk == n.pk {
                continue;
            }
            let addr = SocketAddr::new(from.ip(), port as u16);
            if v["inv"] == true {
                let mut h = HOSTS.lock().unwrap();
                if !h.contains(&addr) {
                    h.push(addr);
                }
            }
            if n.should_dial(pk) {
                let _ = n.connect(addr, None);
            }
        }
    }

    pub fn start(app: &AppHandle) {
        let a = app.clone();
        crate::listen_store(app, move |key, value| {
            if !ls::team_syncable(key) {
                return;
            }
            {
                let mut ap = APPLYING.lock().unwrap();
                if let Some(i) = ap.iter().position(|(k, x)| k == key && *x == value) {
                    ap.remove(i);
                    return; // 방금 받은 원격 변경
                }
            }
            if let Some(n) = NODE.get() {
                n.local_change(key, value);
                persist_meta(&a);
            }
        });
        // 그룹이 이미 있으면 바로 (없으면 만들거나 들어올 때)
        let has = store(app).is_some_and(|s| s.entries().iter().any(|(k, _)| k.starts_with("team.group:")));
        if has {
            serve(app);
        }
    }

    #[derive(Serialize)]
    pub struct State {
        name: String,
        pk: String,
        groups: Vec<Group>,
    }

    pub fn state(app: &AppHandle) -> State {
        let n = node(app);
        State { name: n.name.clone(), pk: n.pk.clone(), groups: n.groups() }
    }

    pub fn create(app: &AppHandle, name: &str, color: &str) -> Group {
        node(app).create_group(name, color)
    }

    /// 초대: 6자리 코드 + 붙여 넣는 초대 문자열 (이 PC 의 사내망 주소)
    pub fn invite(app: &AppHandle, group: &str) -> Result<(String, String), String> {
        let n = node(app);
        serve(app);
        let code = n.invite(group).ok_or("그룹이 없어요")?;
        let gname = n.groups().into_iter().find(|g| g.id == group).map(|g| g.name).unwrap_or_default();
        Ok((code.clone(), invite_string(&code, &local_addrs(), &gname)))
    }

    fn local_addrs() -> Vec<String> {
        // 기본 경로 쪽 출발 주소 (UDP connect 는 패킷을 보내지 않고 OS 가 고른 주소만 알려 준다)
        let mut v = vec![];
        if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if s.connect("10.255.255.255:9").is_ok() {
                if let Ok(a) = s.local_addr() {
                    v.push(format!("{}:{PORT}", a.ip()));
                }
            }
        }
        v
    }

    /// 들어오기: 초대 문자열(주소 포함) · "코드@IP" · 6자리 코드(비콘에서 초대 열린 호스트에 차례로)
    pub fn join(app: &AppHandle, input: &str) -> Result<(), String> {
        let n = node(app);
        let (code, mut addrs) = if let Some((c, a, _)) = parse_invite(input) {
            (c, a.iter().filter_map(|x| x.parse().ok()).collect::<Vec<SocketAddr>>())
        } else if let Some((c, ip)) = input.trim().split_once('@') {
            (c.trim().to_string(), vec![SocketAddr::new(ip.trim().parse().map_err(|_| "IP 주소가 아니에요")?, PORT)])
        } else {
            (input.trim().to_string(), vec![])
        };
        if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
            return Err("초대 코드는 6자리 숫자예요".into());
        }
        if addrs.is_empty() {
            start_listen(&n);
            std::thread::sleep(Duration::from_secs(6)); // 비콘 한두 번
            addrs = HOSTS.lock().unwrap().clone();
        }
        if addrs.is_empty() {
            return Err("초대한 PC 를 찾지 못했어요 — 초대 문자열을 붙여 넣거나 '코드@IP' 로 입력하세요".into());
        }
        let mut last = String::new();
        for a in addrs {
            match n.connect(a, Some(code.clone())) {
                Ok(()) => return Ok(()),
                Err(e) => last = e.to_string(),
            }
        }
        Err(format!("연결하지 못했어요: {last}"))
    }

    pub fn set_name(app: &AppHandle, name: &str) {
        if let Some(s) = store(app) {
            s.set("team.name", name.trim()); // 다음 실행부터 (접속할 때 알리는 이름)
        }
    }

    pub fn flags(app: &AppHandle, group: &str, alarms: bool, news: bool) {
        let n = node(app);
        n.set_group_flags(group, alarms, news);
        if let (Some(g), Some(s)) = (n.groups().into_iter().find(|g| g.id == group), store(app)) {
            s.set(format!("team.group:{group}"), serde_json::to_value(g).unwrap_or(Value::Null));
        }
    }

    /// 수동 IP 연결 (사내망에서 비콘이 막힐 때)
    pub fn dial(app: &AppHandle, ip: &str) -> Result<(), String> {
        let addr = if ip.contains(':') { ip.parse().map_err(|_| "주소 형식이 아니에요")? } else { SocketAddr::new(ip.parse().map_err(|_| "IP 주소가 아니에요")?, PORT) };
        node(app).connect(addr, None).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Peer {
        node: Arc<Node>,
        addr: SocketAddr,
        events: Arc<Mutex<Vec<TeamEv>>>,
    }

    fn peer(name: &str) -> Peer {
        let events: Arc<Mutex<Vec<TeamEv>>> = Arc::new(Mutex::new(vec![]));
        let e2 = events.clone();
        let node = Node::new(name, lf::random32(), vec![], HashMap::new(), ls::Meta::new(), Arc::new(move |e| e2.lock().unwrap().push(e)));
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let n = node.clone();
        std::thread::spawn(move || n.serve(l));
        Peer { node, addr, events }
    }

    fn wait(f: impl Fn() -> bool) -> bool {
        for _ in 0..300 {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn invite_strings() {
        let s = invite_string("123456", &["10.0.0.5:24820".into()], "개발팀");
        assert_eq!(parse_invite(&s), Some(("123456".into(), vec!["10.0.0.5:24820".into()], "개발팀".into())));
        assert_eq!(parse_invite("nope"), None);
    }

    /// 세 그룹원(A·B·C) + 외부인 D: 초대로 들어오기, B 를 거친 릴레이, 묘비, 개인 항목 비공개, 외부인 거부, 틀린 코드
    #[test]
    fn three_members_relay() {
        let (a, b, c, d) = (peer("A"), peer("B"), peer("C"), peer("D"));
        let g = a.node.create_group("개발팀", "#14b8a6");

        // B: A 의 초대 코드로 들어옴 (틀린 코드 먼저 → 거부)
        b.node.connect(a.addr, Some("000000".into())).unwrap();
        assert!(wait(|| b.events.lock().unwrap().iter().any(|e| matches!(e, TeamEv::Joined { ok: false, .. }))));
        let code = a.node.invite(&g.id).unwrap();
        b.node.connect(a.addr, Some(code)).unwrap();
        assert!(wait(|| b.node.groups().iter().any(|x| x.id == g.id && x.members.len() == 2)), "B joined");
        assert!(wait(|| a.node.groups()[0].members.len() == 2));

        // C: B 가 만든 초대로 B 에게 들어옴 (A 와는 직접 연결 없음)
        let code = b.node.invite(&g.id).unwrap();
        c.node.connect(b.addr, Some(code)).unwrap();
        assert!(wait(|| c.node.groups().iter().any(|x| x.id == g.id && x.members.len() == 3)), "C joined");
        assert!(wait(|| a.node.groups()[0].members.len() == 3), "A learns C via B");

        // A 가 그룹 일정 추가 → B 를 거쳐 C 에 도착, 변경 소식(by = A)
        a.node.local_change("event:e1", Some(json!({ "id": "e1", "title": "스프린트 회의", "group": g.id, "by": "A" })));
        assert!(wait(|| c.node.item("event:e1").is_some()), "relayed to C");
        assert!(c.events.lock().unwrap().iter().any(|e| matches!(e, TeamEv::Applied { by, key, .. } if by == "A" && key == "event:e1")));

        // 개인 항목은 어디에도 가지 않는다
        a.node.local_change("todo:mine", Some(json!({ "id": "mine", "title": "개인 할 일" })));
        a.node.local_change("note:mine", Some(json!({ "id": "mine", "text": "개인 메모" })));
        std::thread::sleep(Duration::from_millis(200));
        assert!(b.node.item("todo:mine").is_none() && c.node.item("note:mine").is_none());

        // C 가 지움 → 묘비가 A 까지
        c.node.local_change("event:e1", None);
        assert!(wait(|| a.node.item("event:e1").is_none()), "tombstone reached A");
        assert!(a.events.lock().unwrap().iter().any(|e| matches!(e, TeamEv::Applied { action, .. } if action == "delete")));

        // 메모도 동기화 (그룹 메모판)
        b.node.local_change("note:n1", Some(json!({ "id": "n1", "text": "배포 체크리스트", "group": g.id, "by": "B" })));
        assert!(wait(|| a.node.item("note:n1").is_some() && c.node.item("note:n1").is_some()));

        // 외부인 D: A 에 접속해도 아무것도 못 받고, 위장 tsync 도 무시
        d.node.connect(a.addr, None).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(d.node.item("note:n1").is_none() && d.node.groups().is_empty());
        let dc = d.node.conns.lock().unwrap().first().cloned().unwrap();
        let fake = ls::Item { key: "event:evil".into(), value: Some(json!({ "group": g.id, "title": "x" })), at: now_ms(), scope: format!("group:{}", g.id) };
        let _ = dc.send(json!({ "t": "tsync", "group": g.id, "items": [fake], "by": "D" }));
        std::thread::sleep(Duration::from_millis(300));
        assert!(a.node.item("event:evil").is_none(), "outsider rejected");

        // 그룹원이 다른 그룹 id 를 단 항목으로 위장해도 버림
        let bc = b.node.conns.lock().unwrap().iter().find(|c| lf::hex(&c.peer_pk) == a.node.pk).cloned().unwrap();
        let wrong = ls::Item { key: "event:x".into(), value: Some(json!({ "group": "other", "title": "x" })), at: now_ms(), scope: format!("group:{}", g.id) };
        let _ = bc.send(json!({ "t": "tsync", "group": g.id, "items": [wrong], "by": "B" }));
        std::thread::sleep(Duration::from_millis(200));
        assert!(a.node.item("event:x").is_none());

        for p in [&a, &b, &c, &d] {
            p.node.close_all();
        }
    }
}
