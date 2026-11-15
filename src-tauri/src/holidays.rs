// 한국 공휴일 표 생성기 (시험 전용 — 앱 실행에는 쓰지 않는다. 결과 표는 src/data/holidays.ts 에 넣는다).
// 음력: Meeus 「Astronomical Algorithms」 49장 삭(new moon) + 25장 태양 겉보기 황경 → 중기(中氣) → 달 번호·윤달 (KST 날짜 기준).
// 공휴일: 관공서의 공휴일에 관한 규정 (2026 개정: 노동절·제헌절 편입 — v3 표와 같은 가정) + 대체공휴일 규칙.
// 검증: 2026–2027 은 v3 브랜치의 월력요항 표와 글자 하나까지 같아야 한다 (holidays_match_v3_table).
#![cfg(test)]
#![allow(clippy::needless_range_loop)]

use std::collections::BTreeMap;

const KST: f64 = 9.0 / 24.0;
const DELTA_T: f64 = 70.0 / 86400.0; // 2026–2030 ΔT ≈ 69–71s (TT → UT)

fn rad(d: f64) -> f64 {
    d.to_radians()
}

/// 율리우스일 → (연, 월, 일) (그레고리력)
fn ymd(jd: f64) -> (i32, u32, u32) {
    let z = (jd + 0.5).floor();
    let a = if z < 2299161.0 {
        z
    } else {
        let al = ((z - 1867216.25) / 36524.25).floor();
        z + 1.0 + al - (al / 4.0).floor()
    };
    let b = a + 1524.0;
    let c = ((b - 122.1) / 365.25).floor();
    let d = (365.25 * c).floor();
    let e = ((b - d) / 30.6001).floor();
    let day = (b - d - (30.6001 * e).floor()) as u32;
    let m = if e < 14.0 { e - 1.0 } else { e - 13.0 } as u32;
    let y = if m > 2 { c - 4716.0 } else { c - 4715.0 } as i32;
    (y, m, day)
}

fn jd_of(y: i32, m: u32, d: u32) -> f64 {
    let (y, m) = if m <= 2 { (y - 1, m + 12) } else { (y, m) };
    let a = (y as f64 / 100.0).floor();
    let b = 2.0 - a + (a / 4.0).floor();
    (365.25 * (y as f64 + 4716.0)).floor() + (30.6001 * (m as f64 + 1.0)).floor() + d as f64 + b - 1524.5
}

/// k 번째 삭의 JDE (TT), Meeus 49장 (주기 보정 + 행성 보정)
fn new_moon(k: f64) -> f64 {
    let t = k / 1236.85;
    let mut jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * t * t - 0.000000150 * t.powi(3) + 0.00000000073 * t.powi(4);
    let e = 1.0 - 0.002516 * t - 0.0000074 * t * t;
    let m = rad(2.5534 + 29.10535670 * k - 0.0000014 * t * t);
    let mp = rad(201.5643 + 385.81693528 * k + 0.0107582 * t * t + 0.00001238 * t.powi(3));
    let f = rad(160.7108 + 390.67050284 * k - 0.0016118 * t * t - 0.00000227 * t.powi(3));
    let om = rad(124.7746 - 1.56375588 * k + 0.0020672 * t * t);
    jde += -0.40720 * mp.sin() + 0.17241 * e * m.sin() + 0.01608 * (2.0 * mp).sin() + 0.01039 * (2.0 * f).sin() + 0.00739 * e * (mp - m).sin()
        - 0.00514 * e * (mp + m).sin()
        + 0.00208 * e * e * (2.0 * m).sin()
        - 0.00111 * (mp - 2.0 * f).sin()
        - 0.00057 * (mp + 2.0 * f).sin()
        + 0.00056 * e * (2.0 * mp + m).sin()
        - 0.00042 * (3.0 * mp).sin()
        + 0.00042 * e * (m + 2.0 * f).sin()
        + 0.00038 * e * (m - 2.0 * f).sin()
        - 0.00024 * e * (2.0 * mp - m).sin()
        - 0.00017 * om.sin()
        - 0.00007 * (mp + 2.0 * m).sin()
        + 0.00004 * (2.0 * mp - 2.0 * f).sin()
        + 0.00004 * (3.0 * m).sin()
        + 0.00003 * (mp + m - 2.0 * f).sin()
        + 0.00003 * (2.0 * mp + 2.0 * f).sin()
        - 0.00003 * (mp + m + 2.0 * f).sin()
        + 0.00003 * (mp - m + 2.0 * f).sin()
        - 0.00002 * (mp - m - 2.0 * f).sin()
        - 0.00002 * (3.0 * mp + m).sin()
        + 0.00002 * (4.0 * mp).sin();
    let a = [
        299.77 + 0.107408 * k - 0.009173 * t * t,
        251.88 + 0.016321 * k,
        251.83 + 26.651886 * k,
        349.42 + 36.412478 * k,
        84.66 + 18.206239 * k,
        141.74 + 53.303771 * k,
        207.14 + 2.453732 * k,
        154.84 + 7.306860 * k,
        34.52 + 27.261239 * k,
        207.19 + 0.121824 * k,
        291.34 + 1.844379 * k,
        161.72 + 24.198154 * k,
        239.56 + 25.513099 * k,
        331.55 + 3.592518 * k,
    ];
    let c = [0.000325, 0.000165, 0.000164, 0.000126, 0.000110, 0.000062, 0.000060, 0.000056, 0.000047, 0.000042, 0.000040, 0.000037, 0.000035, 0.000023];
    jde + a.iter().zip(c).map(|(a, c)| c * rad(*a).sin()).sum::<f64>()
}

/// 태양 겉보기 황경 (도), Meeus 25장 저정밀 (±0.01°)
fn sun_lon(jde: f64) -> f64 {
    let t = (jde - 2451545.0) / 36525.0;
    let l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
    let m = rad(357.52911 + 35999.05029 * t - 0.0001537 * t * t);
    let c = (1.914602 - 0.004817 * t - 0.000014 * t * t) * m.sin() + (0.019993 - 0.000101 * t) * (2.0 * m).sin() + 0.000289 * (3.0 * m).sin();
    let om = rad(125.04 - 1934.136 * t);
    (l0 + c - 0.00569 - 0.00478 * om.sin()).rem_euclid(360.0)
}

/// 태양 황경이 target 이 되는 시각(JDE) — 근처 jde0 에서 뉴턴법
fn term_at(target: f64, jde0: f64) -> f64 {
    let mut j = jde0;
    for _ in 0..50 {
        let d = (target - sun_lon(j) + 540.0).rem_euclid(360.0) - 180.0;
        j += d / 360.0 * 365.2422;
        if d.abs() < 1e-7 {
            break;
        }
    }
    j
}

/// TT 율리우스일 → KST 날짜의 '날짜 번호'(정수 JD, 그 날 0시 기준)
fn kst_day(jde: f64) -> i64 {
    (jde - DELTA_T + KST + 0.5).floor() as i64
}

fn day_ymd(day: i64) -> (i32, u32, u32) {
    ymd(day as f64)
}

/// 음력 달 목록 (시작 날짜 번호, 달, 윤달) — from_y 의 전년 동지 무렵부터 to_y 끝까지
fn lunar_months(from_y: i32, to_y: i32) -> Vec<(i64, u32, bool)> {
    let start_jd = jd_of(from_y - 1, 11, 1);
    let mut k = ((start_jd - 2451550.09766) / 29.530588861).floor() - 1.0;
    let end = jd_of(to_y + 2, 2, 1); // 마지막 해의 다음 동지까지
    let mut nm = vec![];
    loop {
        let j = new_moon(k);
        if j > end {
            break;
        }
        if j > start_jd - 40.0 {
            nm.push(kst_day(j));
        }
        k += 1.0;
    }
    // 중기: 황경 0,30,…330 (짝수 절기). 각 중기가 든 달 index
    let has_term = |i: usize| -> Option<u32> {
        let (a, b) = (nm[i], nm[i + 1]);
        (0..12).find(|&n| {
            let target = n as f64 * 30.0;
            // 이 달 시작 근처에서 그 황경 시각
            let j = term_at(target, a as f64 + 15.0);
            let d = kst_day(j);
            d >= a && d < b
        })
    };
    // 동지(270°)가 든 달 = 11월. 동지 사이 달이 13개면 첫 무중월(중기 없는 달)이 윤달
    let mut out = vec![];
    let solstice_month = |y: i32| -> usize {
        let d = kst_day(term_at(270.0, jd_of(y, 12, 21)));
        (0..nm.len() - 1).find(|&i| d >= nm[i] && d < nm[i + 1]).unwrap()
    };
    for y in from_y - 1..=to_y {
        let (s0, s1) = (solstice_month(y), solstice_month(y + 1));
        let leap_year = s1 - s0 == 13;
        let mut leap_done = !leap_year;
        let mut month = 11u32;
        for i in s0..s1 {
            let leap = !leap_done && i > s0 && has_term(i).is_none();
            if leap {
                leap_done = true;
            } else if i > s0 {
                month = month % 12 + 1;
            }
            out.push((nm[i], month, leap));
        }
    }
    out
}

fn weekday(day: i64) -> u32 {
    ((day + 1).rem_euclid(7)) as u32 // 0 = 일요일
}

fn day_num(y: i32, m: u32, d: u32) -> i64 {
    (jd_of(y, m, d) + 0.5) as i64
}

fn key(day: i64) -> String {
    let (y, m, d) = day_ymd(day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 연도별 공휴일 (날짜 → 이름)
pub fn holidays(y: i32, months: &[(i64, u32, bool)], elections: &[(i32, u32, u32, &str)]) -> BTreeMap<String, String> {
    let lunar = |m: u32, d: u32| -> i64 {
        // y 년 안에 드는 음력 m월 d일 (윤달 아님)
        let (s, _, _) = *months.iter().find(|(s, mm, leap)| *mm == m && !*leap && day_ymd(*s + d as i64 - 1).0 == y).unwrap();
        s + d as i64 - 1
    };
    let mut h: BTreeMap<i64, String> = BTreeMap::new();
    let solar = |m, d| day_num(y, m, d);
    h.insert(solar(1, 1), "신정".into());
    let seol = lunar(1, 1);
    h.insert(seol - 1, "설날 연휴".into());
    h.insert(seol, "설날".into());
    h.insert(seol + 1, "설날 연휴".into());
    let chuseok = lunar(8, 15);
    // 추석 연휴는 다른 공휴일(개천절 등)과 겹치면 이름이 남는다 (대체 규칙에서 처리)
    let mut fixed = vec![(solar(3, 1), "삼일절"), (solar(5, 5), "어린이날"), (lunar(4, 8), "부처님오신날"), (solar(6, 6), "현충일"), (solar(8, 15), "광복절"), (solar(10, 3), "개천절"), (solar(10, 9), "한글날"), (solar(12, 25), "성탄절")];
    if y >= 2026 {
        fixed.push((solar(5, 1), "노동절"));
        fixed.push((solar(7, 17), "제헌절"));
    }
    let mut overlap: Vec<i64> = vec![]; // 두 공휴일이 겹친 날 (대체 사유)
    // 겹치면 이름을 잇는다 ("개천절 · 추석")
    let mut put = |h: &mut BTreeMap<i64, String>, d: i64, n: &str| {
        if let Some(cur) = h.get_mut(&d) {
            overlap.push(d);
            *cur = format!("{cur} · {n}");
        } else {
            h.insert(d, n.to_string());
        }
    };
    for (d, n) in &fixed {
        put(&mut h, *d, n);
    }
    for (d, n) in [(chuseok - 1, "추석 연휴"), (chuseok, "추석"), (chuseok + 1, "추석 연휴")] {
        put(&mut h, d, n);
    }
    for (ey, em, ed, n) in elections {
        if *ey == y {
            h.insert(solar(*em, *ed), n.to_string());
        }
    }
    // 대체공휴일
    let is_off = |h: &BTreeMap<i64, String>, d: i64| weekday(d) == 0 || weekday(d) == 6 || h.contains_key(&d);
    let next_free = |h: &BTreeMap<i64, String>, mut d: i64| {
        while is_off(h, d) {
            d += 1;
        }
        d
    };
    // 설·추석: 연휴가 일요일 또는 다른 공휴일과 겹치면 연휴 다음 첫 평일
    for (center, name) in [(seol, "설날"), (chuseok, "추석")] {
        let days = [center - 1, center, center + 1];
        if days.iter().any(|&d| weekday(d) == 0 || overlap.contains(&d)) {
            let d = next_free(&h, center + 2);
            h.insert(d, format!("대체공휴일({name})"));
        }
    }
    // 국경일·어린이날·부처님오신날·성탄절·제헌절: 토·일 또는 다른 공휴일과 겹치면 다음 첫 평일
    let subst = ["삼일절", "어린이날", "부처님오신날", "광복절", "개천절", "한글날", "성탄절", "제헌절"];
    // 겹친 날 하루엔 대체 하루만: 설·추석 연휴와 겹친 경우는 위에서 이미 보상했다
    let lunar_days = [seol - 1, seol, seol + 1, chuseok - 1, chuseok, chuseok + 1];
    for (d, n) in fixed.iter().filter(|(_, n)| subst.contains(n)) {
        let overlap_here = overlap.contains(d) && !lunar_days.contains(d);
        if weekday(*d) == 0 || weekday(*d) == 6 || overlap_here {
            let s = next_free(&h, d + 1);
            h.insert(s, format!("대체공휴일({n})"));
        }
    }
    h.into_iter().map(|(d, n)| (key(d), n)).collect()
}

const ELECTIONS: [(i32, u32, u32, &str); 2] = [(2026, 6, 3, "전국동시지방선거"), (2028, 4, 12, "국회의원선거")];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_moons_match_v3_lunar_table() {
        // v3 브랜치 holidays.ts 의 LUNAR 표 (2026–2027 초하루)
        let want = [
            ("2026-02-17", 1), ("2026-03-19", 2), ("2026-04-17", 3), ("2026-05-17", 4), ("2026-06-15", 5), ("2026-07-14", 6), ("2026-08-13", 7), ("2026-09-11", 8),
            ("2026-10-11", 9), ("2026-11-09", 10), ("2026-12-09", 11), ("2027-01-08", 12), ("2027-02-07", 1), ("2027-03-08", 2), ("2027-04-07", 3), ("2027-05-06", 4),
            ("2027-06-05", 5), ("2027-07-04", 6), ("2027-08-02", 7), ("2027-09-01", 8), ("2027-09-30", 9), ("2027-10-29", 10), ("2027-11-28", 11), ("2027-12-28", 12),
            ("2028-01-27", 1),
        ];
        let ms = lunar_months(2026, 2028);
        for (d, m) in want {
            assert!(ms.iter().any(|(s, mm, leap)| key(*s) == d && *mm == m && !leap), "missing {d} = {m}월");
        }
        // 2028 윤5월 (알려진 사실)
        assert!(ms.iter().any(|(s, m, leap)| *leap && *m == 5 && day_ymd(*s).0 == 2028), "2028 윤5월");
    }

    #[test]
    fn holidays_match_v3_table() {
        let months = lunar_months(2026, 2030);
        let v3_2026 = [
            ("2026-01-01", "신정"), ("2026-02-16", "설날 연휴"), ("2026-02-17", "설날"), ("2026-02-18", "설날 연휴"), ("2026-03-01", "삼일절"), ("2026-03-02", "대체공휴일(삼일절)"),
            ("2026-05-01", "노동절"), ("2026-05-05", "어린이날"), ("2026-05-24", "부처님오신날"), ("2026-05-25", "대체공휴일(부처님오신날)"), ("2026-06-03", "전국동시지방선거"),
            ("2026-06-06", "현충일"), ("2026-07-17", "제헌절"), ("2026-08-15", "광복절"), ("2026-08-17", "대체공휴일(광복절)"), ("2026-09-24", "추석 연휴"), ("2026-09-25", "추석"),
            ("2026-09-26", "추석 연휴"), ("2026-10-03", "개천절"), ("2026-10-05", "대체공휴일(개천절)"), ("2026-10-09", "한글날"), ("2026-12-25", "성탄절"),
        ];
        let v3_2027 = [
            ("2027-01-01", "신정"), ("2027-02-06", "설날 연휴"), ("2027-02-07", "설날"), ("2027-02-08", "설날 연휴"), ("2027-02-09", "대체공휴일(설날)"), ("2027-03-01", "삼일절"),
            ("2027-05-01", "노동절"), ("2027-05-05", "어린이날"), ("2027-05-13", "부처님오신날"), ("2027-06-06", "현충일"), ("2027-07-17", "제헌절"), ("2027-07-19", "대체공휴일(제헌절)"),
            ("2027-08-15", "광복절"), ("2027-08-16", "대체공휴일(광복절)"), ("2027-09-14", "추석 연휴"), ("2027-09-15", "추석"), ("2027-09-16", "추석 연휴"), ("2027-10-03", "개천절"),
            ("2027-10-04", "대체공휴일(개천절)"), ("2027-10-09", "한글날"), ("2027-10-11", "대체공휴일(한글날)"), ("2027-12-25", "성탄절"), ("2027-12-27", "대체공휴일(성탄절)"),
        ];
        for (y, want) in [(2026, &v3_2026[..]), (2027, &v3_2027[..])] {
            let got = holidays(y, &months, &ELECTIONS);
            let want: BTreeMap<String, String> = want.iter().map(|(d, n)| (d.to_string(), n.to_string())).collect();
            assert_eq!(got, want, "{y}");
        }
        // 2028–2030 알려진 날짜 (설·부처님오신날·추석)
        let h28 = holidays(2028, &months, &ELECTIONS);
        let h29 = holidays(2029, &months, &ELECTIONS);
        let h30 = holidays(2030, &months, &ELECTIONS);
        // 2028-01-26 15:12 UTC 합삭 = KST 1/27 00:12 → 한국 설날 1/27 (중국은 1/26)
        assert_eq!(h28.get("2028-01-27").map(String::as_str), Some("설날"));
        assert_eq!(h28.get("2028-05-02").map(String::as_str), Some("부처님오신날"));
        assert_eq!(h28.get("2028-10-03").map(String::as_str), Some("개천절 · 추석")); // 겹침 → 대체 하루
        assert_eq!(h28.iter().filter(|(_, n)| n.starts_with("대체")).map(|(d, _)| d.as_str()).collect::<Vec<_>>(), ["2028-10-05"]);
        assert_eq!(h29.get("2029-05-21").map(String::as_str), Some("대체공휴일(부처님오신날)")); // 일요일
        assert_eq!(h30.get("2030-02-05").map(String::as_str), Some("대체공휴일(설날)")); // 설날이 일요일
        assert_eq!(h29.get("2029-02-13").map(String::as_str), Some("설날"));
        assert_eq!(h29.get("2029-05-20").map(String::as_str), Some("부처님오신날"));
        assert_eq!(h29.get("2029-09-22").map(String::as_str), Some("추석"));
        assert_eq!(h30.get("2030-02-03").map(String::as_str), Some("설날"));
        assert_eq!(h30.get("2030-05-09").map(String::as_str), Some("부처님오신날"));
        assert_eq!(h30.get("2030-09-12").map(String::as_str), Some("추석"));
    }

    /// 표 출력: HERA_HOLIDAYS_OUT=<경로> cargo test --lib emit_holidays -- --ignored
    #[test]
    #[ignore]
    fn emit_holidays() {
        let months = lunar_months(2026, 2030);
        let mut out = String::from("// 생성: src-tauri/src/holidays.rs (cargo test --lib emit_holidays -- --ignored). 2026–2027 은 월력요항 표와 일치 검증.\nconst H: Record<string, string> = {\n");
        for y in 2026..=2030 {
            let line: Vec<String> = holidays(y, &months, &ELECTIONS).into_iter().map(|(d, n)| format!("'{d}': '{n}'")).collect();
            out += &format!("  {},\n\n", line.join(", "));
        }
        out += "}\n\n// 음력 초하루 [양력, 월, 윤달?]\nconst LUNAR: [string, number, boolean?][] = [\n";
        for (s, m, leap) in months.iter().filter(|(s, _, _)| { let y = day_ymd(*s).0; (2025..=2031).contains(&y) }) {
            out += &format!("  ['{}', {m}{}],\n", key(*s), if *leap { ", true" } else { "" });
        }
        out += "]\n";
        std::fs::write(std::env::var("HERA_HOLIDAYS_OUT").unwrap(), out).unwrap();
    }
}
