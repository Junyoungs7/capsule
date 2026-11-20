// Hera Link 화면 넘어감 (a6): 어디서 · 어느 벽으로 넘어갔는지 계산하고, 그 벽이 일렁이는 그림을 만든다. 순수 함수만 (cargo test).
// Hera 는 엔진(deskflow-core) 로그를 '보기만' 한다 — Deskflow·포트 24800 을 시작·정지·설정하지 않는다.
//
// '가끔만 물결' 원인 (a6): 떠날 때 물결 자리를 로그를 읽는 순간의 '지금 커서'로 잡았다. 그런데 엔진은 커서를 맥으로 넘기면
// 이 PC 커서를 화면 가운데로 옮겨 숨긴다 → 로그가 그보다 늦게 읽히면 물결이 가장자리가 아닌 가운데(또는 엉뚱한 가장자리)에 떴다.
// 또 맥이 보내는 'crossed' 와 이 PC 로그가 같은 넘어감을 두 번 그릴 수 있었다.
// → 넘어가기 직전 표본(watch 루프 30Hz) 중 그 벽 쪽으로 가장 나간 점을 벽에 투영 + 같은 넘어감은 한 번만 (Debounce).

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Left,
    Right,
    Up,
    Down,
}

impl Side {
    /// 설정(left/right/top/bottom) · 레이아웃(up/down) 이름 모두
    pub fn parse(s: &str) -> Option<Side> {
        Some(match s {
            "left" => Side::Left,
            "right" => Side::Right,
            "top" | "up" => Side::Up,
            "bottom" | "down" => Side::Down,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        ["left", "right", "up", "down"][self as usize]
    }
    pub fn horizontal(self) -> bool {
        matches!(self, Side::Up | Side::Down)
    }
}

/// 커서 표본 (x, y, ms)
pub type Sample = (i32, i32, u64);

/// 떠난 자리: 넘어가기 전 400ms 안의 표본 중 그 벽 쪽으로 가장 나간 점 → 벽(bb 가장자리)에 투영. 표본이 없으면 벽 가운데.
/// bb = 이 PC 데스크톱 [l, t, r, b] (물리 px, r·b 는 끝 다음 칸)
pub fn leave_point(side: Side, samples: &[Sample], now: u64, bb: [i32; 4]) -> (i32, i32) {
    let recent = samples.iter().filter(|s| now.saturating_sub(s.2) <= 400);
    let key = |s: &&Sample| match side {
        Side::Left => -s.0,
        Side::Right => s.0,
        Side::Up => -s.1,
        Side::Down => s.1,
    };
    let along = recent.max_by_key(key).map(|s| if side.horizontal() { s.0 } else { s.1 });
    let mid = if side.horizontal() { (bb[0] + bb[2]) / 2 } else { (bb[1] + bb[3]) / 2 };
    let a = along.unwrap_or(mid);
    match side {
        Side::Left => (bb[0], a.max(bb[1]).min(bb[3] - 1)),
        Side::Right => (bb[2] - 1, a.max(bb[1]).min(bb[3] - 1)),
        Side::Up => (a.max(bb[0]).min(bb[2] - 1), bb[1]),
        Side::Down => (a.max(bb[0]).min(bb[2] - 1), bb[3] - 1),
    }
}

/// 일렁일 벽 = 그 점이 있는 모니터의 그 쪽 가장자리 띠. mons = ([x, y, w, h], 배율)
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Wall {
    pub rect: [i32; 4], // 띠 창 (물리 px)
    pub u0: f32,        // 띠 안에서 넘어간 점 (벽 방향 좌표, px)
    pub side: Side,
}
pub const WALL_DIP: f64 = 32.0;

pub fn wall_for(side: Side, pt: (i32, i32), mons: &[([i32; 4], f64)]) -> Option<Wall> {
    let (x, y) = pt;
    let dist = |m: &[i32; 4]| {
        let dx = (m[0] - x).max(x - (m[0] + m[2] - 1)).max(0);
        let dy = (m[1] - y).max(y - (m[1] + m[3] - 1)).max(0);
        dx + dy
    };
    let (m, s) = mons.iter().min_by_key(|(m, _)| dist(m))?;
    let d = (WALL_DIP * s).round() as i32;
    let rect = match side {
        Side::Left => [m[0], m[1], d, m[3]],
        Side::Right => [m[0] + m[2] - d, m[1], d, m[3]],
        Side::Up => [m[0], m[1], m[2], d],
        Side::Down => [m[0], m[1] + m[3] - d, m[2], d],
    };
    let u0 = if side.horizontal() { (x - m[0]).max(0).min(m[2] - 1) } else { (y - m[1]).max(0).min(m[3] - 1) } as f32;
    Some(Wall { rect, u0, side })
}

/// 같은 넘어감을 두 번 그리지 않기: 같은 방향이 250ms 안에 또 오면 버린다 (이 PC 로그 + 맥의 'crossed')
#[derive(Default)]
pub struct Debounce(pub Option<(bool, u64)>);
impl Debounce {
    pub fn accept(&mut self, on_peer: bool, now: u64) -> bool {
        if matches!(self.0, Some((d, t)) if d == on_peer && now.saturating_sub(t) < 250) {
            return false;
        }
        self.0 = Some((on_peer, now));
        true
    }
}

/// 벽 물결 한 프레임 (premultiplied BGRA, 띠 창 그대로의 모양: 좌우 벽 = depth×len, 위아래 벽 = len×depth).
/// 넘어간 점 u0 에서 양쪽으로 퍼지는 물결: 밝은 '수면' 선이 벽에서 살짝 들어갔다 나왔다 하며, 앞쪽 파도가 지나가며 사그라든다.
/// t = 0..1. reduced = 움직임 줄이기 → 물결 없이 벽 전체가 부드럽게 한 번 빛남. 마지막 프레임(t ≥ 1)은 모두 0 = 거둠.
pub fn render_wall(buf: &mut [u32], len: usize, depth: usize, u0: f32, t: f32, reduced: bool, side: Side) {
    let wall_at_zero = matches!(side, Side::Left | Side::Up);
    let dpx = depth as f32;
    let speed = len.max(1) as f32 * 0.9; // 0.8초에 벽 끝까지
    let front = speed * t;
    let fade = (1.0 - t).max(0.0).powf(1.3);
    for v in 0..depth {
        // 벽에서의 거리 (0 = 벽)
        let dist = if wall_at_zero { v as f32 } else { dpx - 1.0 - v as f32 };
        for u in 0..len {
            let du = (u as f32 - u0).abs();
            let a = if t >= 1.0 {
                0.0
            } else if reduced {
                let g = (std::f32::consts::PI * t).sin() * 0.5;
                g * (-dist / (dpx * 0.35)).exp()
            } else {
                // 파도 앞머리 (퍼져 나가며 약해짐) + 그 뒤의 잔물결
                let behind = front - du;
                let env = if behind < 0.0 { (-(behind * behind) / (2.0 * (dpx * 1.2).powi(2))).exp() } else { (-behind / (dpx * 6.0)).exp() };
                let damp = (-du / (len as f32 * 0.45)).exp();
                let amp = env * damp * fade;
                // 수면 선: 벽에서 2px + 출렁임 (최대 depth 의 40%)
                let wave = (behind.max(0.0) / (dpx * 1.6) * std::f32::consts::TAU).cos();
                let surf = 2.0 + amp * dpx * 0.4 * (0.5 + 0.5 * wave);
                let e = (dist - surf) / 2.2;
                let line = (-e * e).exp();
                let glow = (-dist / (dpx * 0.45)).exp() * 0.35;
                (line * 0.9 + glow) * amp
            };
            let a = a.clamp(0.0, 1.0);
            let i = if side.horizontal() { v * len + u } else { u * depth + v };
            buf[i] = if a < 0.004 {
                0
            } else {
                // 강조색(파랑) → 진한 곳은 밝은 하늘색, premultiplied
                let (r, g, b) = (40.0 + 150.0 * a, 132.0 + 100.0 * a, 255.0);
                let p = |c: f32| (c * a).min(255.0) as u32;
                (((a * 255.0) as u32) << 24) | (p(r) << 16) | (p(g) << 8) | p(b)
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: [i32; 4] = [0, 0, 1920, 1080];

    #[test]
    fn leave_point_is_on_the_wall_not_where_the_engine_parked_the_cursor() {
        // 오른쪽으로 끌다가 넘어감 → 엔진이 커서를 가운데(960,540)로 옮김. 지금 커서가 아니라 직전 표본으로.
        let s = [(1700, 300, 900), (1880, 310, 933), (1915, 312, 966), (960, 540, 999)];
        assert_eq!(leave_point(Side::Right, &s, 1000, ONE), (1919, 312));
        assert_eq!(leave_point(Side::Left, &[(40, 700, 990), (3, 702, 995), (960, 540, 999)], 1000, ONE), (0, 702));
        assert_eq!(leave_point(Side::Up, &[(500, 9, 990), (960, 540, 999)], 1000, ONE), (500, 0));
        assert_eq!(leave_point(Side::Down, &[(1200, 1070, 990)], 1000, ONE), (1200, 1079));
        // 오래된 표본뿐 → 벽 가운데
        assert_eq!(leave_point(Side::Right, &[(1915, 100, 10)], 1000, ONE), (1919, 540));
        // 두 모니터 (오른쪽에 1.5배 2880×1620): 데스크톱 상자의 오른쪽 벽
        let bb = [0, 0, 1920 + 2880, 1620];
        assert_eq!(leave_point(Side::Right, &[(4790, 1500, 999)], 1000, bb), (4799, 1500));
    }

    #[test]
    fn wall_strip_follows_the_monitor_and_dpi() {
        let mons = [([0, 0, 1920, 1080], 1.0), ([1920, -200, 2880, 1620], 1.5)];
        // 오른쪽 모니터(150%)의 오른쪽 벽: 띠 = 32 × 1.5 = 48px, 그 모니터 높이 전체
        let w = wall_for(Side::Right, (4799, 300), &mons).unwrap();
        assert_eq!(w.rect, [1920 + 2880 - 48, -200, 48, 1620]);
        assert_eq!(w.u0, 500.0); // 모니터 위에서 500px
        // 왼쪽 모니터(100%)의 왼쪽 벽
        assert_eq!(wall_for(Side::Left, (0, 1079), &mons).unwrap().rect, [0, 0, 32, 1080]);
        // 위쪽 벽 (125%) — 가로 띠
        let w = wall_for(Side::Up, (700, 0), &[([0, 0, 2560, 1440], 1.25)]).unwrap();
        assert_eq!((w.rect, w.u0), ([0, 0, 2560, 40], 700.0));
        assert_eq!(wall_for(Side::Down, (100, 1439), &[([0, 0, 2560, 1440], 1.25)]).unwrap().rect, [0, 1400, 2560, 40]);
        assert!(wall_for(Side::Right, (0, 0), &[]).is_none());
        assert_eq!(Side::parse("top"), Some(Side::Up));
        assert_eq!(Side::parse("bottom").map(Side::name), Some("down"));
    }

    #[test]
    fn every_crossing_exactly_once() {
        let mut d = Debounce::default();
        assert!(d.accept(true, 1000)); // 맥으로
        assert!(!d.accept(true, 1100)); // 같은 넘어감 (맥의 crossed 메아리) → 버림
        assert!(d.accept(false, 1200)); // 돌아옴 (방향이 다르면 바로)
        assert!(d.accept(true, 1300)); // 다시 맥으로 (빠르게 오가도 매번)
        assert!(d.accept(true, 1600)); // 같은 방향이라도 250ms 지나면 새 넘어감
    }

    #[test]
    fn wall_wave_starts_at_the_crossing_and_is_torn_down() {
        let (len, depth) = (1080usize, 32usize);
        let mut b = vec![0u32; len * depth];
        let a = |b: &[u32], u: usize| (0..depth).map(|v| b[u * depth + v] >> 24).max().unwrap(); // 오른쪽 벽: depth 폭 × len 높이
        // 시작: 넘어간 점(300) 근처만 밝고 먼 곳은 어둡다
        render_wall(&mut b, len, depth, 300.0, 0.05, false, Side::Right);
        assert!(a(&b, 300) > 40 && a(&b, 900) < a(&b, 300) / 4, "{} {}", a(&b, 300), a(&b, 900));
        let col = |v: usize| b[300 * depth + v] >> 24;
        assert!(col(depth - 3) > col(4), "light hugs the right wall"); // 수면 선은 벽 쪽
        // 중간: 파도가 양쪽으로 퍼짐 (앞머리가 가운데보다 멀리 있다)
        render_wall(&mut b, len, depth, 300.0, 0.4, false, Side::Right);
        let front = 300 + (len as f32 * 0.9 * 0.4) as usize;
        assert!(a(&b, front.min(len - 1)) > 10 && a(&b, 0) > 0);
        // 끝: 모두 0 (띠 창을 숨기고 버퍼를 놓는다)
        render_wall(&mut b, len, depth, 300.0, 1.0, false, Side::Right);
        assert!(b.iter().all(|&p| p == 0));
        // 움직임 줄이기: 물결 없음 — 벽 전체가 고르게 한 번 빛남
        render_wall(&mut b, len, depth, 300.0, 0.5, true, Side::Right);
        assert_eq!(a(&b, 0), a(&b, 1000));
        // 프레임 비용 (가장 큰 벽: 150% 세로 2160 × 48): 40프레임 × 20ms 안에 그린다
        let (len, depth) = (2160usize, 48usize);
        let mut b = vec![0u32; len * depth];
        let t0 = std::time::Instant::now();
        for i in 0..40 {
            render_wall(&mut b, len, depth, 1000.0, i as f32 / 40.0, false, Side::Left);
        }
        let per = t0.elapsed().as_secs_f64() * 1000.0 / 40.0;
        println!("WALL frame {per:.2}ms (debug build)");
        assert!(per < 40.0, "{per}ms");
    }
}
