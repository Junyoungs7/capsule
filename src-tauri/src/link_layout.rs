// Hera Link 모니터별 배치 → 엔진 링크(가장자리 범위). 플랫폼 코드 없음 (맥 빌드도 공용).
// 엔진은 PC 하나를 '화면 하나'(모든 모니터의 경계 상자)로 본다. 그래서 링크는 그 경계 상자 가장자리의 % 구간:
//   right(50,100) = MacBook(0,54.99)   (Deskflow 1.27: strtod 실수, 0..100, 같은 방향끼리 겹치면 안 됨)
// 패널 캔버스에서 맥 모니터를 끌어 PC 모니터에 붙이면, 맞닿은 구간만 넘어가게 변환한다.
// 표현 못 하는 배치(경계 상자 안쪽 가장자리에 붙임 등)는 limits 로 설명한다.
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mon {
    pub id: String,
    pub mac: bool,
    /// 그 OS 의 가상 데스크톱 좌표 [x, y, w, h] (윈도우 = 물리 px, 맥 = 포인트)
    pub rect: [f64; 4],
    /// 패널 캔버스 [x, y, w, h] (공통 단위 ≈ 논리 px)
    pub at: [f64; 4],
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Seg {
    /// 윈도우 화면 기준 방향: left / right / up / down
    pub side: String,
    /// 윈도우 경계 상자 가장자리 % 구간
    pub win: (f64, f64),
    /// 맥 경계 상자 반대쪽 가장자리 % 구간
    pub mac: (f64, f64),
    /// 윈도우 가상 데스크톱의 그 가장자리 구간 [x, y, w, h] (가장자리 끌어 놓기 띠 위치, 두께 0)
    pub edge: [f64; 4],
}

#[derive(Clone, Serialize, Debug, PartialEq, Default)]
pub struct Plan {
    pub segs: Vec<Seg>,
    pub limits: Vec<String>,
}

const EPS: f64 = 1.5; // 캔버스 맞닿음 허용 (패널은 정확히 스냅)
const TOL: f64 = 2.0; // 경계 상자 가장자리 판정 (실좌표)

fn bbox(ms: &[&Mon]) -> [f64; 4] {
    let (mut l, mut t, mut r, mut b) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for m in ms {
        l = l.min(m.rect[0]);
        t = t.min(m.rect[1]);
        r = r.max(m.rect[0] + m.rect[2]);
        b = b.max(m.rect[1] + m.rect[3]);
    }
    [l, t, r, b]
}

fn opposite(side: &str) -> &'static str {
    match side {
        "left" => "right",
        "right" => "left",
        "up" => "down",
        _ => "up",
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// 모니터의 한 가장자리가 그 OS 경계 상자의 같은 쪽 가장자리 위에 있나
fn on_bbox(m: &Mon, side: &str, bb: [f64; 4]) -> bool {
    let [x, y, w, h] = m.rect;
    match side {
        "right" => (x + w - bb[2]).abs() <= TOL,
        "left" => (x - bb[0]).abs() <= TOL,
        "down" => (y + h - bb[3]).abs() <= TOL,
        _ => (y - bb[1]).abs() <= TOL,
    }
}

/// 캔버스 구간 [a, b] (가장자리 축) → 그 OS 경계 상자 가장자리의 % 구간
fn pct(m: &Mon, horizontal_edge: bool, a: f64, b: f64, bb: [f64; 4]) -> (f64, f64) {
    let (cpos, clen, rpos, rlen, bpos, blen) = if horizontal_edge {
        (m.at[0], m.at[2], m.rect[0], m.rect[2], bb[0], bb[2] - bb[0])
    } else {
        (m.at[1], m.at[3], m.rect[1], m.rect[3], bb[1], bb[3] - bb[1])
    };
    let f = |c: f64| ((rpos + (c - cpos) / clen * rlen) - bpos) / blen * 100.0;
    (round2(f(a).clamp(0.0, 100.0)), round2(f(b).clamp(0.0, 100.0)))
}

pub fn plan(mons: &[Mon]) -> Plan {
    let wins: Vec<&Mon> = mons.iter().filter(|m| !m.mac).collect();
    let macs: Vec<&Mon> = mons.iter().filter(|m| m.mac).collect();
    let mut p = Plan::default();
    if wins.is_empty() || macs.is_empty() {
        return p;
    }
    let (bw, bm) = (bbox(&wins), bbox(&macs));
    for w in &wins {
        for m in &macs {
            let (wa, ma) = (w.at, m.at);
            // (방향, 맞닿음, 가장자리가 가로인가)
            let rel = [
                ("right", (wa[0] + wa[2] - ma[0]).abs() <= EPS, false),
                ("left", (ma[0] + ma[2] - wa[0]).abs() <= EPS, false),
                ("down", (wa[1] + wa[3] - ma[1]).abs() <= EPS, true),
                ("up", (ma[1] + ma[3] - wa[1]).abs() <= EPS, true),
            ];
            for (side, touch, horiz) in rel {
                if !touch {
                    continue;
                }
                let (a, b) = if horiz { (wa[0].max(ma[0]), (wa[0] + wa[2]).min(ma[0] + ma[2])) } else { (wa[1].max(ma[1]), (wa[1] + wa[3]).min(ma[1] + ma[3])) };
                if b - a <= 1.0 {
                    continue; // 모서리만 닿음
                }
                if !on_bbox(w, side, bw) {
                    p.limits.push(format!("PC 모니터 {} 의 {} 가장자리는 PC 화면 안쪽이라 맥으로 넘어갈 수 없어요", w.id, kor(side)));
                    continue;
                }
                if !on_bbox(m, opposite(side), bm) {
                    p.limits.push(format!("맥 모니터 {} 의 {} 가장자리는 맥 화면 안쪽이라 연결할 수 없어요", m.id, kor(opposite(side))));
                    continue;
                }
                let win = pct(w, horiz, a, b, bw);
                let mac = pct(m, horiz, a, b, bm);
                if win.1 - win.0 < 0.5 || mac.1 - mac.0 < 0.5 {
                    continue;
                }
                // 윈도우 가상 좌표의 가장자리 구간 (띠 위치)
                let s = |v: f64, lo: f64, hi: f64| lo + v / 100.0 * (hi - lo);
                let edge = match side {
                    "right" => [bw[2], s(win.0, bw[1], bw[3]), 0.0, s(win.1, bw[1], bw[3]) - s(win.0, bw[1], bw[3])],
                    "left" => [bw[0], s(win.0, bw[1], bw[3]), 0.0, s(win.1, bw[1], bw[3]) - s(win.0, bw[1], bw[3])],
                    "down" => [s(win.0, bw[0], bw[2]), bw[3], s(win.1, bw[0], bw[2]) - s(win.0, bw[0], bw[2]), 0.0],
                    _ => [s(win.0, bw[0], bw[2]), bw[1], s(win.1, bw[0], bw[2]) - s(win.0, bw[0], bw[2]), 0.0],
                };
                p.segs.push(Seg { side: side.into(), win, mac, edge });
            }
        }
    }
    // 같은 방향끼리 겹치면 엔진이 거부한다 → 앞 구간에 맞춰 자르고 알린다 (윈도우 쪽·맥 쪽 모두)
    p.segs.sort_by(|a, b| (a.side.as_str(), a.win.0).partial_cmp(&(b.side.as_str(), b.win.0)).unwrap());
    let mut out: Vec<Seg> = vec![];
    for s in p.segs.drain(..) {
        let clash = out.iter().any(|o| {
            (o.side == s.side && s.win.0 < o.win.1 && o.win.0 < s.win.1) || (opposite(&o.side) == opposite(&s.side) && s.mac.0 < o.mac.1 && o.mac.0 < s.mac.1)
        });
        if clash {
            p.limits.push(format!("{} 쪽 연결 구간이 서로 겹쳐서 하나만 써요", kor(&s.side)));
        } else {
            out.push(s);
        }
    }
    p.segs = out;
    p
}

/// 점에서 가장 가까운 경계 상자 가장자리 (물결 방향)
#[cfg_attr(not(windows), allow(dead_code))]
pub fn nearest_side(bb: [f64; 4], x: f64, y: f64) -> &'static str {
    let d = [(x - bb[0]).abs(), (bb[2] - 1.0 - x).abs(), (y - bb[1]).abs(), (bb[3] - 1.0 - y).abs()];
    let i = (0..4).min_by(|&a, &b| d[a].partial_cmp(&d[b]).unwrap()).unwrap();
    ["left", "right", "up", "down"][i]
}

/// 맥 가장자리 위치(맥 쪽 방향, 0..1) → 이어진 PC 가장자리의 화면 좌표와 PC 쪽 방향
#[cfg_attr(not(windows), allow(dead_code))]
pub fn mac_to_win(segs: &[Seg], mac_side: &str, pos: f64) -> Option<(f64, f64, &'static str)> {
    let p = pos * 100.0;
    let g = segs.iter().find(|g| opposite(&g.side) == mac_side && p >= g.mac.0 - 0.01 && p <= g.mac.1 + 0.01)?;
    let f = ((p - g.mac.0) / (g.mac.1 - g.mac.0).max(0.01)).clamp(0.0, 1.0);
    let e = g.edge;
    let side: &'static str = match g.side.as_str() {
        "left" => "left",
        "right" => "right",
        "up" => "up",
        _ => "down",
    };
    Some(if e[2] == 0.0 { (e[0], e[1] + f * e[3], side) } else { (e[0] + f * e[2], e[1], side) })
}

fn kor(side: &str) -> &'static str {
    match side {
        "left" => "왼쪽",
        "right" => "오른쪽",
        "up" => "위",
        _ => "아래",
    }
}

/// 엔진 links 섹션 (구간이 없으면 기존처럼 한 방향 전체 연결)
pub fn links_section(me: &str, peer: &str, segs: &[Seg], fallback_side: &str) -> String {
    let f = |v: f64| {
        let s = format!("{v:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    let mut s = format!("section: links\n\t{me}:\n");
    if segs.is_empty() {
        let (go, back) = match fallback_side {
            "left" => ("left", "right"),
            "top" => ("up", "down"),
            "bottom" => ("down", "up"),
            _ => ("right", "left"),
        };
        return format!("{s}\t\t{go} = {peer}\n\t{peer}:\n\t\t{back} = {me}\nend\n");
    }
    for g in segs {
        s += &format!("\t\t{}({},{}) = {peer}({},{})\n", g.side, f(g.win.0), f(g.win.1), f(g.mac.0), f(g.mac.1));
    }
    s += &format!("\t{peer}:\n");
    for g in segs {
        s += &format!("\t\t{}({},{}) = {me}({},{})\n", opposite(&g.side), f(g.mac.0), f(g.mac.1), f(g.win.0), f(g.win.1));
    }
    s + "end\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(id: &str, rect: [f64; 4], scale: f64) -> Mon {
        Mon { id: id.into(), mac: false, rect, at: [rect[0] / scale, rect[1] / scale, rect[2] / scale, rect[3] / scale] }
    }
    fn mac(id: &str, rect: [f64; 4], at_xy: [f64; 2]) -> Mon {
        Mon { id: id.into(), mac: true, rect, at: [at_xy[0], at_xy[1], rect[2], rect[3]] }
    }

    #[test]
    fn side_by_side_full_edge() {
        let p = plan(&[win("1", [0.0, 0.0, 1920.0, 1080.0], 1.0), mac("m1", [0.0, 0.0, 1920.0, 1080.0], [1920.0, 0.0])]);
        assert!(p.limits.is_empty());
        assert_eq!(p.segs.len(), 1);
        assert_eq!((p.segs[0].side.as_str(), p.segs[0].win, p.segs[0].mac), ("right", (0.0, 100.0), (0.0, 100.0)));
        assert_eq!(links_section("PC", "Mac", &p.segs, "right"), "section: links\n\tPC:\n\t\tright(0,100) = Mac(0,100)\n\tMac:\n\t\tleft(0,100) = PC(0,100)\nend\n");
    }

    #[test]
    fn offset_heights() {
        // 맥(1512×982)을 PC 오른쪽 아래쪽 절반에 붙임 → PC 오른쪽 50~100% 만, 맥 왼쪽 0~54.99%
        let p = plan(&[win("1", [0.0, 0.0, 1920.0, 1080.0], 1.0), mac("air", [0.0, 0.0, 1512.0, 982.0], [1920.0, 540.0])]);
        assert_eq!(p.segs[0].win, (50.0, 100.0));
        assert_eq!(p.segs[0].mac, (0.0, 54.99));
        assert_eq!(p.segs[0].edge, [1920.0, 540.0, 0.0, 540.0]);
    }

    #[test]
    fn dual_monitors_both_sides() {
        // PC 두 대(가로), 맥 두 대: 하나는 PC 오른쪽, 하나는 PC 왼쪽 모니터 위
        let mons = [
            win("1", [0.0, 0.0, 1920.0, 1080.0], 1.0),
            win("2", [1920.0, 0.0, 1920.0, 1080.0], 1.0),
            mac("m1", [0.0, 0.0, 1512.0, 982.0], [3840.0, 0.0]),
            mac("m2", [1512.0, 0.0, 1920.0, 1080.0], [0.0, -1080.0]),
        ];
        let p = plan(&mons);
        // m2 의 아래 가장자리 = 맥 경계 상자(높이 1080) 아래 → OK, PC 위쪽 0~50%(왼쪽 모니터) ↔ 맥 아래 44.06~100%
        let up = p.segs.iter().find(|s| s.side == "up").unwrap();
        assert_eq!(up.win, (0.0, 50.0));
        assert_eq!(up.mac, (44.06, 100.0)); // 1512 / 3432
        // m1 은 맥 경계 상자의 왼쪽 → PC 오른쪽 전체 높이 0~90.93% (982/1080)
        let right = p.segs.iter().find(|s| s.side == "right").unwrap();
        assert_eq!(right.win, (0.0, 90.93));
        assert_eq!(right.mac, (0.0, 90.93)); // 맥 경계 상자 높이 1080 기준
        assert!(p.limits.is_empty(), "{:?}", p.limits);
    }

    #[test]
    fn stacked_and_hidpi() {
        // 4K 150% 모니터(캔버스 2560×1440) 아래에 맥: 물리 좌표로 환산해도 비율은 같다
        let p = plan(&[win("4k", [0.0, 0.0, 3840.0, 2160.0], 1.5), mac("m", [0.0, 0.0, 1280.0, 800.0], [640.0, 1440.0])]);
        assert_eq!(p.segs[0].side, "down");
        assert_eq!(p.segs[0].win, (25.0, 75.0));
        assert_eq!(p.segs[0].mac, (0.0, 100.0));
        assert_eq!(p.segs[0].edge, [960.0, 2160.0, 1920.0, 0.0]);
    }

    #[test]
    fn inner_edge_is_a_limit() {
        // PC: 왼쪽 모니터가 더 낮음(높이 차) → 왼쪽 모니터 아래는 경계 상자 아래가 아님
        let mons = [
            win("1", [0.0, 0.0, 1920.0, 1080.0], 1.0),
            win("2", [1920.0, 0.0, 1920.0, 1440.0], 1.0),
            mac("m", [0.0, 0.0, 1512.0, 982.0], [0.0, 1080.0]),
        ];
        let p = plan(&mons);
        assert!(p.segs.is_empty());
        assert_eq!(p.limits.len(), 1);
        assert!(p.limits[0].contains("PC 모니터 1"));
    }

    #[test]
    fn overlapping_segments_trimmed() {
        // 맥 두 대를 PC 오른쪽 같은 높이에 겹치게 → 하나만 쓰고 알림
        let mons = [win("1", [0.0, 0.0, 1920.0, 1080.0], 1.0), mac("a", [0.0, 0.0, 1000.0, 800.0], [1920.0, 0.0]), mac("b", [0.0, 800.0, 1000.0, 800.0], [1920.0, 400.0])];
        let p = plan(&mons);
        assert_eq!(p.segs.len(), 1);
        assert!(p.limits.iter().any(|l| l.contains("겹쳐")));
    }

    #[test]
    fn edge_helpers() {
        let bb = [0.0, 0.0, 3840.0, 1080.0];
        assert_eq!(nearest_side(bb, 3839.0, 500.0), "right");
        assert_eq!(nearest_side(bb, 0.0, 500.0), "left");
        assert_eq!(nearest_side(bb, 1000.0, 1079.0), "down");
        let p = plan(&[win("1", [0.0, 0.0, 1920.0, 1080.0], 1.0), mac("air", [0.0, 0.0, 1512.0, 982.0], [1920.0, 540.0])]);
        // 맥 왼쪽 가장자리 27.5% (0~54.99 구간의 절반) → PC 오른쪽 가장자리 y = 540 + 270
        let (x, y, side) = mac_to_win(&p.segs, "left", 0.27495).unwrap();
        assert_eq!((x, y.round(), side), (1920.0, 810.0, "right"));
        assert!(mac_to_win(&p.segs, "left", 0.9).is_none()); // 이어지지 않은 곳
    }

    #[test]
    fn no_layout_falls_back() {
        assert_eq!(links_section("PC", "Mac", &[], "top"), "section: links\n\tPC:\n\t\tup = Mac\n\tMac:\n\t\tdown = PC\nend\n");
        assert_eq!(plan(&[win("1", [0.0, 0.0, 10.0, 10.0], 1.0)]), Plan::default());
    }
}
