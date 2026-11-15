// Hera Link 할 일·일정 동기화 (플랫폼 코드 없음). 항목마다 마지막에 쓴 쪽이 이김(LWW, updatedAt ms) + 지운 항목은 묘비.
// Hera Team(그룹 공유, .omc/plans/hera-team.md)을 위해 항목마다 scope 를 싣는다: "personal" | "group:<id>".
// 지금은 두 PC 사이 personal 만 오가고, 그룹은 나중에 같은 merge 를 다른 채널로 쓴다.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Item {
    pub key: String,          // store 키 (todo:<id> / event:<id>)
    pub value: Option<Value>, // None = 지움(묘비)
    pub at: i64,              // 마지막 변경 시각 (epoch ms)
    pub scope: String,
}

/// 로컬 메타: 키 → (마지막 변경 시각, 지움). store `sync.meta` 로 저장 (재시작해도 묘비 유지)
pub type Meta = HashMap<String, (i64, bool)>;

pub fn syncable(key: &str) -> bool {
    key.starts_with("todo:") || key.starts_with("event:")
}

pub fn scope_of(v: Option<&Value>) -> String {
    v.and_then(|v| v["scope"].as_str()).unwrap_or("personal").to_string()
}

/// 받은 항목 중 적용할 것 (내 것보다 새것 + 허용된 scope). 같은 시각이면 키 값 비교로 결정(양쪽이 같은 답).
pub fn merge(meta: &Meta, incoming: &[Item], allow: impl Fn(&str) -> bool) -> Vec<Item> {
    incoming
        .iter()
        .filter(|i| syncable(&i.key) && allow(&i.scope))
        .filter(|i| match meta.get(&i.key) {
            None => true,
            Some(&(at, _)) => i.at > at,
        })
        .cloned()
        .collect()
}

/// 지금 상태 전체 (접속 직후 보낼 것): 살아 있는 항목 + 묘비
pub fn snapshot(meta: &Meta, live: &[(String, Value)], allow: impl Fn(&str) -> bool) -> Vec<Item> {
    let mut v: Vec<Item> = live
        .iter()
        .filter(|(k, val)| syncable(k) && allow(&scope_of(Some(val))))
        .map(|(k, val)| Item { key: k.clone(), value: Some(val.clone()), at: meta.get(k).map_or(0, |m| m.0), scope: scope_of(Some(val)) })
        .collect();
    v.extend(meta.iter().filter(|(_, m)| m.1).map(|(k, m)| Item { key: k.clone(), value: None, at: m.0, scope: "personal".into() }));
    v
}

/// 오래된 묘비 정리 (30일)
pub fn gc(meta: &mut Meta, now: i64) {
    meta.retain(|_, m| !(m.1 && now - m.0 > 30 * 86_400_000));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn it(key: &str, at: i64, v: Option<Value>) -> Item {
        Item { key: key.into(), value: v, at, scope: "personal".into() }
    }

    #[test]
    fn lww_and_tombstones() {
        let mut meta = Meta::new();
        meta.insert("todo:a".into(), (100, false));
        meta.insert("todo:b".into(), (300, false));
        meta.insert("todo:c".into(), (200, true)); // 내가 지움
        let inc = [
            it("todo:a", 150, Some(json!({"title": "새것"}))), // 더 새것 → 적용
            it("todo:b", 250, Some(json!({"title": "옛것"}))), // 더 옛것 → 무시
            it("todo:c", 150, Some(json!({"title": "되살리기?"}))), // 지운 뒤 옛 수정 → 무시 (묘비 승)
            it("todo:d", 1, Some(json!({}))), // 처음 보는 것 → 적용
            it("event:e", 500, None), // 상대가 지움 → 적용(삭제)
            it("record:x", 999, Some(json!({}))), // 동기화 대상 아님
        ];
        let keys: Vec<_> = merge(&meta, &inc, |s| s == "personal").into_iter().map(|i| i.key).collect();
        assert_eq!(keys, ["todo:a", "todo:d", "event:e"]);
        // 같은 시각은 적용 안 함 (양쪽 모두 같은 결론 → 왕복 없음)
        assert!(merge(&meta, &[it("todo:a", 100, None)], |_| true).is_empty());
    }

    #[test]
    fn scopes_and_snapshot() {
        let meta: Meta = [("todo:a".to_string(), (10, false)), ("todo:gone".to_string(), (20, true))].into();
        let live = vec![("todo:a".to_string(), json!({"title": "a"})), ("todo:g".to_string(), json!({"title": "g", "scope": "group:team1"})), ("dock.pinned".to_string(), json!([]))];
        let snap = snapshot(&meta, &live, |s| s == "personal");
        let keys: Vec<_> = snap.iter().map(|i| (i.key.as_str(), i.value.is_some(), i.at)).collect();
        assert_eq!(keys, [("todo:a", true, 10), ("todo:gone", false, 20)]); // 그룹 항목은 personal 채널로 안 감
        let group = Item { scope: "group:team1".into(), ..it("todo:g", 5, Some(json!({}))) };
        assert!(merge(&Meta::new(), std::slice::from_ref(&group), |s| s == "personal").is_empty());
        assert_eq!(merge(&Meta::new(), &[group], |s| s.starts_with("group:")).len(), 1);
        let mut m = meta.clone();
        gc(&mut m, 20 + 31 * 86_400_000);
        assert!(m.contains_key("todo:a") && !m.contains_key("todo:gone"));
    }
}
