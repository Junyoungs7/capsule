// v3 화면 글자 복사 (OCR): 단축키 Ctrl+Alt+T / ⌘K → 커서가 있는 모니터를 먼저 캡처(오버레이가 찍히지 않게) → 어둡게·영역 선택 창 →
// 고른 영역만 잘라 Windows.Media.Ocr (한국어 언어 팩이 있으면 ko, 없으면 사용자 프로필 언어). 캡처는 메모리에만, 창을 닫으면 버림.
use std::sync::Mutex;

use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetMonitorInfoW, MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    CAPTUREBLT, DIB_RGB_COLORS, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// 캡처 1장: 모니터 rect [x, y, w, h] (물리 px) + BGRA 픽셀
pub struct Shot {
    pub rect: [i32; 4],
    pub bgra: Vec<u8>,
}

static SHOT: Mutex<Option<Shot>> = Mutex::new(None);

/// 커서가 있는 모니터 전체를 캡처해 보관하고 그 rect 를 돌려준다
pub fn capture_at_cursor() -> Result<[i32; 4], String> {
    let mut pt = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut pt);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST), &mut mi).as_bool() {
            return Err("모니터 정보를 못 읽었어요".into());
        }
        let r = mi.rcMonitor;
        let rect = [r.left, r.top, r.right - r.left, r.bottom - r.top];
        let shot = grab(rect)?;
        *SHOT.lock().unwrap() = Some(shot);
        Ok(rect)
    }
}

/// 화면 rect 를 BitBlt 로 (계층 창 포함 CAPTUREBLT)
pub fn grab(rect: [i32; 4]) -> Result<Shot, String> {
    let [x, y, w, h] = rect;
    unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let bi = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() }, ..Default::default() };
        let mut bits = std::ptr::null_mut();
        let bmp = CreateDIBSection(Some(dc), &bi, DIB_RGB_COLORS, &mut bits, None, 0).map_err(|e| e.to_string())?;
        let old = SelectObject(dc, bmp.into());
        let ok = BitBlt(dc, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT).is_ok();
        let mut bgra = std::slice::from_raw_parts(bits as *const u8, (w * h * 4) as usize).to_vec();
        SelectObject(dc, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        if !ok {
            return Err("화면을 캡처하지 못했어요".into());
        }
        for px in bgra.chunks_exact_mut(4) {
            px[3] = 255; // BitBlt 알파는 의미 없음
        }
        Ok(Shot { rect, bgra })
    }
}

/// 보관한 캡처에서 영역 자르기 (모니터 기준 물리 px). 작은 영역은 2배 키워 인식률을 높인다.
pub fn crop(shot: &Shot, [x, y, w, h]: [i32; 4]) -> Option<(u32, u32, Vec<u8>)> {
    let (sw, sh) = (shot.rect[2], shot.rect[3]);
    let (x0, y0) = (x.clamp(0, sw), y.clamp(0, sh));
    let (x1, y1) = ((x + w).clamp(0, sw), (y + h).clamp(0, sh));
    let (cw, ch) = (x1 - x0, y1 - y0);
    if cw < 4 || ch < 4 {
        return None;
    }
    let k = if ch < 120 { 2 } else { 1 };
    let mut out = Vec::with_capacity((cw * ch * 4 * k * k) as usize);
    for yy in 0..ch * k {
        let row = ((y0 + yy / k) * sw * 4) as usize;
        for xx in 0..cw * k {
            let o = row + ((x0 + xx / k) * 4) as usize;
            out.extend_from_slice(&shot.bgra[o..o + 4]);
        }
    }
    Some(((cw * k) as u32, (ch * k) as u32, out))
}

/// Windows.Media.Ocr → (텍스트, 쓴 언어 태그). 줄은 \n 으로.
pub fn recognize(w: u32, h: u32, bgra: &[u8]) -> Result<(String, String), String> {
    let e = |x: windows::core::Error| x.message().to_string();
    let writer = DataWriter::new().map_err(e)?;
    writer.WriteBytes(bgra).map_err(e)?;
    let buf = writer.DetachBuffer().map_err(e)?;
    let bmp = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buf, BitmapPixelFormat::Bgra8, w as i32, h as i32, BitmapAlphaMode::Premultiplied).map_err(e)?;
    let ko = Language::CreateLanguage(&HSTRING::from("ko")).map_err(e)?;
    let engine = if OcrEngine::IsLanguageSupported(&ko).unwrap_or(false) { OcrEngine::TryCreateFromLanguage(&ko) } else { OcrEngine::TryCreateFromUserProfileLanguages() }
        .map_err(|_| "이 PC 에 OCR 언어 팩이 없어요 (설정 > 시간 및 언어 > 언어에서 한국어/영어 '광학 문자 인식' 설치)".to_string())?;
    let lang = engine.RecognizerLanguage().and_then(|l| l.LanguageTag()).map(|t| t.to_string()).unwrap_or_default();
    let res = engine.RecognizeAsync(&bmp).map_err(e)?.join().map_err(e)?;
    let mut lines = vec![];
    for line in res.Lines().map_err(e)? {
        lines.push(line.Text().map_err(e)?.to_string());
    }
    Ok((lines.join("\n"), lang))
}

/// 선택 영역(오버레이 창 CSS px × 배율 = 모니터 기준 물리 px) → 텍스트
pub fn region(rect: [i32; 4]) -> Result<(String, String), String> {
    let _ = unsafe { windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED) }; // WinRT
    let (w, h, px) = {
        let g = SHOT.lock().unwrap();
        let shot = g.as_ref().ok_or("캡처가 없어요 — 다시 시작하세요")?;
        crop(shot, rect).ok_or("영역이 너무 작아요")?
    };
    recognize(w, h, &px)
}

pub fn clear() {
    *SHOT.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_rules() {
        let shot = Shot { rect: [0, 0, 10, 10], bgra: (0..400).map(|i| i as u8).collect() };
        let (w, h, px) = crop(&shot, [2, 3, 4, 5]).unwrap();
        assert_eq!((w, h), (8, 10)); // 작은 영역 → 2배
        assert_eq!(&px[..4], &shot.bgra[(3 * 10 + 2) * 4..(3 * 10 + 2) * 4 + 4]);
        assert!(crop(&shot, [8, 8, 10, 10]).is_none()); // 화면 밖으로 잘려 너무 작음
        assert_eq!(crop(&shot, [-5, -5, 20, 20]).map(|c| (c.0, c.1)), Some((20, 20)));
    }

    /// OS 의 OCR 엔진으로 실제 인식 (GDI 로 그린 글자): cargo test --lib ocr_engine -- --ignored --nocapture
    #[test]
    #[ignore]
    fn ocr_engine() {
        use windows::core::w;
        use windows::Win32::Graphics::Gdi::*;
        let (w_, h_) = (900i32, 160i32);
        let px = unsafe {
            let dc = CreateCompatibleDC(None);
            let bi = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w_, biHeight: -h_, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() }, ..Default::default() };
            let mut bits = std::ptr::null_mut();
            let bmp = CreateDIBSection(Some(dc), &bi, DIB_RGB_COLORS, &mut bits, None, 0).unwrap();
            SelectObject(dc, bmp.into());
            std::slice::from_raw_parts_mut(bits as *mut u32, (w_ * h_) as usize).fill(0x00FF_FFFF);
            let font = CreateFontW(56, 0, 0, 0, 400, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, 0, w!("Malgun Gothic"));
            SelectObject(dc, font.into());
            let text: Vec<u16> = "Hello Hera 2026 안녕하세요".encode_utf16().collect();
            let _ = TextOutW(dc, 20, 40, &text);
            let mut v = std::slice::from_raw_parts(bits as *const u8, (w_ * h_ * 4) as usize).to_vec();
            v.chunks_exact_mut(4).for_each(|p| p[3] = 255);
            v
        };
        let _ = unsafe { windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED) };
        let (text, lang) = recognize(w_ as u32, h_ as u32, &px).unwrap();
        println!("OCR lang={lang} text={text:?}");
        assert!(text.contains("Hello") || text.contains("Hera"), "{text}");
    }
}
