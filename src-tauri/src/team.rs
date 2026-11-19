// Hera Team: 같은 사내망의 동료 PC 들과 그룹 단위로 일정(event:)·메모(note:)만 공유 (.omc/plans/hera-team.md).
// 서버 없음. 전송·암호는 Hera Link 파일 채널(link_files: X25519+HKDF+ChaCha20-Poly1305)을 그대로, 포트·비콘만 따로 (24820 / UDP 24821).
// 신원: 각 PC 의 장기 공개키. 그룹 = 그룹원 공개키 목록. 들어오기 = 그룹원이 만든 6자리 초대 코드(10분, 5번 틀리면 폐기).
// 동기화 = link_sync (항목마다 최종 수정 우선 + 묘비, scope = group:<id>). 온라인 그룹원이 새로 받은 항목을 다른 그룹원에게 전달(릴레이).
// 개인 항목(그룹 필드 없음)은 절대 보내지 않는다 — 보낼 때도 받을 때도 그 그룹의 그룹원인지 확인.
// 채팅(chat:<id>) = 같은 동기화(그룹마다 방 1개, 늦게 켠 사람도 따라잡기) + 보관 기간(기본 30일, 지난 건 주고받지 않음).
// 채팅 파일·사진은 메시지에 {fid, from(보낸 사람 공개키)} 만 싣고, 받는 쪽이 보낸 사람에게 직접 'cget' → 같은 암호 채널로 전송.
// 보낸 사람이 오프라인이면 받을 수 없다(서버·중계 저장 없음) — 다시 온라인이 되면 받는다.
use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::link_files::{self as lf, Conn};
use crate::link_sync as ls;

pub const PORT: u16 = 24820;
pub const BEACON_PORT: u16 = 24821;
/// 채팅 보관 기간(일) — store `chat.retentionDays` (기본 30)
pub static RETAIN_DAYS: AtomicI64 = AtomicI64::new(30);

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
    /// 채팅 파일 전송 진행 (dir = in | out)
    ChatXfer { fid: String, dir: String, bytes: u64, size: u64 },
    /// 채팅 파일을 다 받음 (임시 경로 — 위층이 옮긴다)
    ChatFile { fid: String, path: String },
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
    /// 내가 보낸 채팅 파일: fid → (경로, 그룹) — 그 그룹원이 요청하면 직접 보낸다
    outbox: Mutex<HashMap<String, (PathBuf, String)>>,
    /// 요청해 둔 채팅 파일: (fid, 파일 이름) — 진행률을 메시지에 잇는다
    pending: Mutex<Vec<(String, String)>>,
    /// (a10) 나간 그룹 — 늦게 만난 그룹원이 옛 그룹 정보로 다시 끌어들이지 않게 + 아직 모르는 그룹원에게 알릴 것
    left: Mutex<Vec<Left>>,
    sink: TeamSink,
}

/// 나간 그룹 기록: 그 뒤(at 보다 새로) 다시 초대되면 들어올 수 있다. tell = 아직 '나감'을 못 알린 그룹원 공개키
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Left {
    pub id: String,
    pub at: i64,
    pub tell: Vec<String>,
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
            outbox: Mutex::new(HashMap::new()),
            pending: Mutex::new(vec![]),
            left: Mutex::new(vec![]),
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

    /// (a10) 저장해 둔 '나간 그룹' 되살리기 (시작할 때)
    pub fn set_left(&self, left: Vec<Left>) {
        *self.left.lock().unwrap() = left;
    }

    pub fn left_list(&self) -> Vec<Left> {
        self.left.lock().unwrap().clone()
    }

    fn left_after(&self, group: &str, rev: i64) -> bool {
        self.left.lock().unwrap().iter().any(|l| l.id == group && rev <= l.at)
    }

    /// (a10) 그룹 나가기: 이 PC 에서만 그룹·항목(일정·메모·채팅)을 지우고 그룹원에게 '나감'을 알린다.
    /// 그룹원은 나를 그룹원 목록에서 빼고 서로 알린다 — 그들의 그룹·항목은 그대로. 지운 항목은 묘비를 보내지 않는다 (그룹이 먼저 사라져서).
    /// 돌려주는 값 = 이 그룹이던 항목 키 (위층이 store·파일을 지운다)
    pub fn leave_group(&self, group: &str) -> Option<Vec<String>> {
        let g = {
            let mut gs = self.groups.lock().unwrap();
            let i = gs.iter().position(|g| g.id == group)?;
            gs.remove(i)
        };
        let keys: Vec<String> = {
            let mut items = self.items.lock().unwrap();
            let keys: Vec<String> = items.iter().filter(|(k, v)| group_of(Some(v)).as_deref() == Some(group) || (k.starts_with("tomb:") && v.as_str() == Some(group))).map(|(k, _)| k.clone()).collect();
            for k in &keys {
                items.remove(k);
            }
            keys
        };
        {
            let mut meta = self.meta.lock().unwrap();
            for k in &keys {
                meta.remove(k.strip_prefix("tomb:").unwrap_or(k));
            }
        }
        self.outbox.lock().unwrap().retain(|_, (_, gid)| gid != group);
        self.invites.lock().unwrap().retain(|i| i.group != group);
        let mut tell: Vec<String> = g.members.iter().map(|m| m.pk.clone()).filter(|pk| *pk != self.pk).collect();
        for c in self.conns.lock().unwrap().iter().filter(|c| c.is_ready()) {
            let pk = lf::hex(&c.peer_pk);
            if tell.contains(&pk) && c.send(json!({ "t": "tleave", "group": group })).is_ok() {
                tell.retain(|x| *x != pk);
            }
        }
        self.left.lock().unwrap().push(Left { id: group.into(), at: now_ms(), tell });
        Some(keys.into_iter().filter(|k| !k.starts_with("tomb:")).collect())
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
        let (now, days) = (now_ms(), RETAIN_DAYS.load(Ordering::Relaxed));
        v.retain(|i| !ls::expired(&i.key, i.value.as_ref(), now, days));
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
        let (now, days) = (now_ms(), RETAIN_DAYS.load(Ordering::Relaxed));
        let items: Vec<ls::Item> = items.into_iter().filter(|i| !ls::expired(&i.key, i.value.as_ref(), now, days)).collect();
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
                None if g.has(&self.pk) && !self.left_after(&g.id, g.rev) => {
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
                let first = !self.groups.lock().unwrap().iter().any(|x| x.id == g.id) && !self.left_after(&g.id, g.rev);
                self.update_group(g.clone(), Some(from));
                if first && g.has(&self.pk) {
                    (self.sink)(TeamEv::Joined { group: g.id.clone(), ok: true, error: String::new() });
                }
            }
            "cget" => {
                // 그룹원이 내 채팅 파일을 달라고 함 → 그 그룹원일 때만 이 연결로 직접
                let fid = msg["fid"].as_str().unwrap_or("").to_string();
                let Some((path, group)) = self.outbox.lock().unwrap().get(&fid).cloned() else { return };
                let Some(c) = self.conn_of(&pk).filter(|_| member_of(&group)) else { return };
                let sink = self.sink.clone();
                std::thread::spawn(move || {
                    let f2 = fid.clone();
                    let prog: lf::Sink = Arc::new(move |e| {
                        if let lf::Event::Xfer { bytes, size, .. } = e {
                            sink(TeamEv::ChatXfer { fid: f2.clone(), dir: "out".into(), bytes, size });
                        }
                    });
                    if let Err(e) = c.send_file_meta(&path, &prog, json!({ "cfid": fid })) {
                        eprintln!("chat file {fid}: {e}");
                    }
                });
            }
            "tleave" => {
                // (a10) 그룹원이 나감 → 목록에서 빼고(새 rev) 다른 그룹원에게 알린다. 그 그룹원이 아니면 무시
                let gid = msg["group"].as_str().unwrap_or("").to_string();
                let g = {
                    let mut gs = self.groups.lock().unwrap();
                    let Some(g) = gs.iter_mut().find(|g| g.id == gid && g.has(&pk)) else { return };
                    g.members.retain(|m| m.pk != pk);
                    g.rev = now_ms();
                    g.clone()
                };
                (self.sink)(TeamEv::Group { group: g.clone() });
                self.send_to(&gid, &json!({ "t": "tgroup", "group": g }), Some(from));
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
        // 받는 중인 채팅 파일: 전송 이름 → fid (offer 의 cfid 는 Received 때만 오므로 요청할 때 적어 둔 이름으로 맞춘다)
        let sink: lf::Sink = Arc::new(move |e: lf::Event| match e {
            lf::Event::Msg { msg } => {
                if let Some((pk, name)) = p2.lock().unwrap().clone() {
                    me2.handle(&pk, &name, &msg);
                }
            }
            lf::Event::Xfer { dir, name, bytes, size, .. } if dir == "in" => {
                if let Some(fid) = me2.pending_fid(&name) {
                    (me2.sink)(TeamEv::ChatXfer { fid, dir, bytes, size });
                }
            }
            lf::Event::Received { path, meta, .. } => {
                if let Some(fid) = meta["cfid"].as_str().filter(|f| !f.is_empty()) {
                    me2.pending.lock().unwrap().retain(|(f, _)| f != fid);
                    (me2.sink)(TeamEv::ChatFile { fid: fid.into(), path });
                } else {
                    let _ = std::fs::remove_file(&path); // 팀 채널로 온 채팅 외 파일은 받지 않는다
                }
            }
            _ => {}
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
            // (a10) 나간 그룹을 아직 모르는 그룹원이면 알린다 (한 번)
            for l in me.left.lock().unwrap().iter_mut().filter(|l| l.tell.contains(&pk)) {
                if c.send(json!({ "t": "tleave", "group": l.id })).is_ok() {
                    l.tell.retain(|x| *x != pk);
                }
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

    /// 내 채팅 파일 등록 (보낸 메시지의 fid → 원본 경로)
    pub fn offer_file(&self, fid: &str, path: PathBuf, group: &str) {
        self.outbox.lock().unwrap().insert(fid.into(), (path, group.into()));
    }

    /// 채팅 파일 받기 요청: 보낸 사람(공개키)과 연결돼 있을 때만. 보냈으면 true.
    pub fn request_file(&self, fid: &str, name: &str, from_pk: &str) -> bool {
        let Some(c) = self.conn_of(from_pk) else { return false };
        let mut p = self.pending.lock().unwrap();
        if !p.iter().any(|(f, _)| f == fid) {
            p.push((fid.into(), name.into()));
        }
        drop(p);
        c.send(json!({ "t": "cget", "fid": fid })).is_ok()
    }

    fn pending_fid(&self, name: &str) -> Option<String> {
        self.pending.lock().unwrap().iter().find(|(_, n)| n == name).map(|(f, _)| f.clone())
    }

    /// 그룹원 공개키로 이미 연결돼 있나 (비콘 중복 접속 방지)
    pub fn connected_to(&self, pk: &str) -> bool {
        self.conns.lock().unwrap().iter().any(|c| c.is_ready() && lf::hex(&c.peer_pk) == pk)
    }

    /// 비콘을 받았을 때 접속할 상대인가: 같은 그룹원 + 아직 연결 안 됨 + 공개키가 내 것보다 큼(양쪽이 동시에 걸지 않게)
    pub fn should_dial(&self, pk: &str) -> bool {
        pk > self.pk.as_str() && !self.connected_to(pk) && (self.groups.lock().unwrap().iter().any(|g| g.has(pk)) || self.left.lock().unwrap().iter().any(|l| l.tell.iter().any(|x| x == pk)))
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
            let n = Node::new(&my_name(app), secret, groups, items, meta, Arc::new(move |e| on_team(&a, e)));
            n.set_left(get("team.left").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default());
            n
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
            TeamEv::Applied { key, value, .. } if key.starts_with("chat:") => {
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
                // 남이 보낸 새 메시지: Island 알림(빠른 답장) + 읽지 않음, 파일이면 보낸 사람에게서 바로 받기
                let me = NODE.get().map(|n| n.pk.clone()).unwrap_or_default();
                if let Some(v) = value.as_ref().filter(|v| v["byPk"].as_str() != Some(me.as_str())) {
                    if let Some(s) = store(app) {
                        let n = s.get("chat.unread").and_then(|v| v.as_i64()).unwrap_or(0);
                        s.set("chat.unread", n + 1);
                    }
                    let _ = app.emit_to("island", "chat-msg", v);
                    fetch_file(app, v);
                }
            }
            TeamEv::ChatXfer { .. } => {}
            TeamEv::ChatFile { fid, path } => {
                // 임시 폴더 → %APPDATA%\<앱>\chat\<fid>\<이름> (사진 미리보기 = asset 프로토콜 범위)
                let dest = chat_dir(app, "chat").map(|d| d.join(fid));
                if let (Some(dest), Some(name)) = (dest, std::path::Path::new(path).file_name()) {
                    let _ = std::fs::create_dir_all(&dest);
                    let to = dest.join(name);
                    if std::fs::rename(path, &to).or_else(|_| std::fs::copy(path, &to).map(|_| ())).is_ok() {
                        let _ = std::fs::remove_file(path);
                        if let Some(s) = store(app) {
                            s.set(format!("chatin:{fid}"), to.display().to_string());
                        }
                    }
                }
            }
            TeamEv::Online { pk, online: true, .. } => {
                // 다시 온라인이 된 그룹원이 보냈던 파일 중 아직 못 받은 것
                if let Some(s) = store(app) {
                    for (k, v) in s.entries() {
                        if k.starts_with("chat:") && v["from"].as_str() == Some(pk.as_str()) {
                            fetch_file(app, &v);
                        }
                    }
                }
            }
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

    fn chat_dir(app: &AppHandle, sub: &str) -> Option<PathBuf> {
        use tauri::Manager;
        app.path().app_data_dir().ok().map(|d| d.join(sub))
    }

    /// 파일 메시지 → 아직 안 받았으면 보낸 사람에게 요청 (연결돼 있을 때만)
    fn fetch_file(app: &AppHandle, v: &Value) {
        let (Some(fid), Some(from), Some(name)) = (v["fid"].as_str(), v["from"].as_str(), v["name"].as_str()) else { return };
        let have = store(app).and_then(|s| s.get(format!("chatin:{fid}"))).and_then(|p| p.as_str().map(|p| std::path::Path::new(p).exists())).unwrap_or(false);
        if !have {
            if let Some(n) = NODE.get() {
                n.request_file(fid, name, from);
            }
        }
    }

    /// 채팅 보내기 (파일·사진): 원본을 %APPDATA%\chat-out\<fid>\<이름> 으로 복사 → 등록 → 메시지 저장(= 그룹에 동기화)
    pub fn chat_send_file(app: &AppHandle, group: &str, src: &std::path::Path) -> Result<String, String> {
        let n = node(app);
        if !n.groups().iter().any(|g| g.id == group) {
            return Err("그룹이 없어요".into());
        }
        let max_mb = store(app).and_then(|s| s.get("chat.maxMB")).and_then(|v| v.as_u64()).unwrap_or(100);
        let size = std::fs::metadata(src).map_err(|e| e.to_string())?.len();
        if size > max_mb * 1024 * 1024 {
            return Err(format!("{max_mb}MB보다 큰 파일은 보낼 수 없어요"));
        }
        let name = src.file_name().ok_or("파일 이름 없음")?.to_string_lossy().into_owned();
        let fid = lf::hex(&lf::random32())[..16].to_string();
        let dir = chat_dir(app, "chat-out").ok_or("앱 데이터 폴더 없음")?.join(&fid);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let to = dir.join(&name);
        std::fs::copy(src, &to).map_err(|e| e.to_string())?;
        n.offer_file(&fid, to.clone(), group);
        let img = matches!(to.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(), Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"));
        let id = lf::hex(&lf::random32())[..16].to_string();
        if let Some(s) = store(app) {
            s.set(format!("chatout:{fid}"), json!({ "path": to.display().to_string(), "group": group }));
            s.set(format!("chatin:{fid}"), to.display().to_string()); // 내 것도 미리보기·열기 경로
            s.set(format!("chat:{id}"), json!({ "id": id, "group": group, "by": n.name, "byPk": n.pk, "kind": if img { "image" } else { "file" }, "name": name, "size": size, "fid": fid, "from": n.pk, "at": now_ms() }));
        }
        Ok(id)
    }

    /// 보관 기간이 지난 채팅 + 그 파일을 이 PC 에서만 정리 (store 리스너를 걸기 전에 — 묘비가 나가지 않게)
    fn prune_chat(app: &AppHandle) {
        let Some(s) = store(app) else { return };
        let days = s.get("chat.retentionDays").and_then(|v| v.as_i64()).filter(|d| *d > 0).unwrap_or(30);
        RETAIN_DAYS.store(days, Ordering::Relaxed);
        let now = now_ms();
        let mut meta: ls::Meta = s.get("team.meta").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        for (k, v) in s.entries() {
            if ls::expired(&k, Some(&v), now, days) {
                s.delete(&k);
                meta.remove(&k);
                if let Some(fid) = v["fid"].as_str() {
                    for sub in ["chat", "chat-out"] {
                        if let Some(d) = chat_dir(app, sub) {
                            let _ = std::fs::remove_dir_all(d.join(fid));
                        }
                    }
                    s.delete(format!("chatin:{fid}"));
                    s.delete(format!("chatout:{fid}"));
                }
            }
        }
        s.set("team.meta", serde_json::to_value(&meta).unwrap_or(Value::Null));
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
        loop {
            let msg = json!({ "hera-team": 1, "pk": n.pk, "port": PORT, "inv": n.has_open_invite() }).to_string();
            lf::broadcast(msg.as_bytes(), BEACON_PORT);
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
        prune_chat(app);
        // 내가 보낸 채팅 파일 다시 등록 (재시작 후에도 그룹원이 받을 수 있게)
        if let Some(s) = store(app) {
            let n = node(app);
            for (k, v) in s.entries() {
                if let (Some(fid), Some(p), Some(g)) = (k.strip_prefix("chatout:"), v["path"].as_str(), v["group"].as_str()) {
                    n.offer_file(fid, PathBuf::from(p), g);
                }
            }
        }
        let a = app.clone();
        crate::listen_store(app, move |key, value| {
            if key == "chat.retentionDays" {
                RETAIN_DAYS.store(value.as_ref().and_then(|v| v.as_i64()).filter(|d| *d > 0).unwrap_or(30), Ordering::Relaxed);
            }
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
        online: Vec<String>, // 지금 연결된 그룹원 공개키 (늦게 뜬 창도 온라인 표시)
    }

    pub fn state(app: &AppHandle) -> State {
        let n = node(app);
        let online = n.conns.lock().unwrap().iter().filter(|c| c.is_ready()).map(|c| lf::hex(&c.peer_pk)).collect();
        State { name: n.name.clone(), pk: n.pk.clone(), groups: n.groups(), online }
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
        // 기본 경로 랜카드 주소 (예전 10.255.255.255 기준은 10.x VPN 어댑터 주소를 고를 수 있었다)
        lf::lan_ip().map(|ip| format!("{ip}:{PORT}")).into_iter().collect()
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
            return Err("초대한 PC를 찾지 못했어요 — 초대 문자열을 붙여 넣거나 '코드@IP' 로 입력하세요".into());
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

    /// (a10) 그룹 나가기: 그룹을 이 PC 에서 지우고(일정·메모·채팅·받은/보낸 채팅 파일) 그룹원에게 알린다. 그룹원 쪽 기록은 그대로.
    /// 되돌리기 5초는 JS 가 기다린 뒤에만 부른다 (나감은 남에게 보이므로 지웠다 다시 넣지 않는다).
    pub fn leave(app: &AppHandle, group: &str) -> Result<(), String> {
        let n = node(app);
        let keys = n.leave_group(group).ok_or("그룹이 없어요")?;
        if let Some(s) = store(app) {
            s.delete(format!("team.group:{group}"));
            s.set("team.left", serde_json::to_value(n.left_list()).unwrap_or(Value::Null));
            // 그룹 항목: store 에 있는 것 + 노드가 알던 것
            let mut ks: Vec<(String, Value)> = s.entries().into_iter().filter(|(k, v)| ls::team_syncable(k) && group_of(Some(v)).as_deref() == Some(group)).collect();
            ks.extend(keys.into_iter().filter_map(|k| s.get(&k).map(|v| (k, v))));
            for (k, v) in ks {
                s.delete(&k);
                if let Some(fid) = v["fid"].as_str() {
                    for sub in ["chat", "chat-out"] {
                        if let Some(d) = chat_dir(app, sub) {
                            let _ = std::fs::remove_dir_all(d.join(fid));
                        }
                    }
                    s.delete(format!("chatin:{fid}"));
                    s.delete(format!("chatout:{fid}"));
                }
            }
            if s.get("chat.group").is_some_and(|v| v.as_str() == Some(group)) {
                s.delete("chat.group");
            }
        }
        persist_meta(app);
        let _ = app.emit("team", json!({ "kind": "left", "group": group }));
        Ok(())
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
    fn chat_messages_and_files() {
        let (a, b, d) = (peer("A"), peer("B"), peer("D"));
        let g = a.node.create_group("채팅방", "#8b5cf6");
        let code = a.node.invite(&g.id).unwrap();
        b.node.connect(a.addr, Some(code)).unwrap();
        assert!(wait(|| b.node.groups().iter().any(|x| x.id == g.id)), "B joined");

        // 메시지 = chat:<id> 그룹 동기화
        let now = now_ms();
        a.node.local_change("chat:m1", Some(json!({ "id": "m1", "group": g.id, "by": "A", "kind": "text", "text": "내일 3시 회의", "at": now })));
        assert!(wait(|| b.node.item("chat:m1").is_some()), "message reached B");
        // 보관 기간 지난 메시지는 보내도 적용되지 않는다
        a.node.local_change("chat:old", Some(json!({ "id": "old", "group": g.id, "by": "A", "kind": "text", "text": "옛날", "at": now - 40 * 86_400_000 })));
        std::thread::sleep(Duration::from_millis(300));
        assert!(b.node.item("chat:old").is_none(), "expired message not applied");

        // 파일: A 가 등록 → B 가 A 에게 직접 요청 → 받음 (진행 이벤트 포함)
        let dir = std::env::temp_dir().join(format!("hera-chat-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("빌드로그.txt");
        std::fs::write(&src, vec![b'x'; 300_000]).unwrap();
        a.node.offer_file("f1", src.clone(), &g.id);
        assert!(b.node.request_file("f1", "빌드로그.txt", &a.node.pk));
        assert!(wait(|| b.events.lock().unwrap().iter().any(|e| matches!(e, TeamEv::ChatFile { fid, .. } if fid == "f1"))), "file received");
        let got = b.events.lock().unwrap().iter().find_map(|e| if let TeamEv::ChatFile { path, .. } = e { Some(path.clone()) } else { None }).unwrap();
        assert_eq!(std::fs::read(&got).unwrap().len(), 300_000);
        assert!(b.events.lock().unwrap().iter().any(|e| matches!(e, TeamEv::ChatXfer { fid, dir, .. } if fid == "f1" && dir == "in")));
        let _ = std::fs::remove_file(&got);

        // 그룹원이 아닌 D 는 같은 fid 를 요청해도 받지 못한다
        d.node.connect(a.addr, None).unwrap();
        assert!(wait(|| d.node.connected_to(&a.node.pk)));
        d.node.request_file("f1", "빌드로그.txt", &a.node.pk);
        std::thread::sleep(Duration::from_millis(500));
        assert!(!d.events.lock().unwrap().iter().any(|e| matches!(e, TeamEv::ChatFile { .. })), "non-member got nothing");
        // 보낸 사람이 없으면(연결 없음) 요청 자체가 안 된다
        assert!(!b.node.request_file("f2", "x", "00ff"));
        let _ = std::fs::remove_dir_all(&dir);
        for p in [&a, &b, &d] {
            p.node.close_all();
        }
    }

    /// (a10) 나가기: A 가 나감 → A 쪽 그룹·항목 없음, B·C 는 그대로 (A 만 목록에서 빠짐), 옛 그룹 정보로는 다시 안 끌려 들어옴,
    /// 나간 뒤 A 에게 그룹 항목이 오지 않음, 나중에 다시 초대되면 들어올 수 있음
    #[test]
    fn leave_group_wipes_here_keeps_peers() {
        let (a, b, c) = (peer("A"), peer("B"), peer("C"));
        let g = a.node.create_group("개발팀", "#14b8a6");
        let code = a.node.invite(&g.id).unwrap();
        b.node.connect(a.addr, Some(code)).unwrap();
        assert!(wait(|| b.node.groups().iter().any(|x| x.id == g.id)));
        let code = b.node.invite(&g.id).unwrap();
        c.node.connect(b.addr, Some(code)).unwrap();
        assert!(wait(|| a.node.groups()[0].members.len() == 3));
        a.node.local_change("event:e1", Some(json!({ "id": "e1", "title": "회의", "group": g.id, "by": "A" })));
        b.node.local_change("note:n1", Some(json!({ "id": "n1", "text": "메모", "group": g.id, "by": "B" })));
        assert!(wait(|| a.node.item("note:n1").is_some() && c.node.item("event:e1").is_some()));
        let old = a.node.groups()[0].clone();

        let keys = a.node.leave_group(&g.id).unwrap();
        assert!(keys.contains(&"event:e1".to_string()) && keys.contains(&"note:n1".to_string()), "{keys:?}");
        assert!(a.node.groups().is_empty() && a.node.item("event:e1").is_none() && a.node.item("note:n1").is_none(), "wiped here");
        assert!(a.node.leave_group(&g.id).is_none(), "twice = nothing");
        // 그룹원: A 만 빠지고 항목은 그대로 (묘비 없음)
        assert!(wait(|| b.node.groups()[0].members.len() == 2 && c.node.groups()[0].members.len() == 2), "B and C drop A");
        assert!(!b.node.groups()[0].has(&a.node.pk));
        std::thread::sleep(Duration::from_millis(200));
        assert!(b.node.item("event:e1").is_some() && c.node.item("note:n1").is_some(), "peers keep their copies");
        // 나간 뒤 그룹 항목은 A 에게 적용되지 않는다
        b.node.local_change("event:e2", Some(json!({ "id": "e2", "title": "나간 뒤", "group": g.id, "by": "B" })));
        std::thread::sleep(Duration::from_millis(300));
        assert!(a.node.item("event:e2").is_none());
        // 옛 그룹 정보(나가기 전 rev)로는 다시 안 들어온다
        a.node.update_group(old, None);
        assert!(a.node.groups().is_empty(), "stale group info does not pull A back");
        // 다시 초대 → 들어올 수 있다
        let code = b.node.invite(&g.id).unwrap();
        a.node.connect(b.addr, Some(code)).unwrap();
        assert!(wait(|| a.node.groups().iter().any(|x| x.id == g.id)), "re-invite works");
        for p in [&a, &b, &c] {
            p.node.close_all();
        }
    }

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
