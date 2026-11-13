// 아이콘 추출: IShellItemImageFactory 256px ICONONLY → 알파 un-premultiply → appData/icons/<hash>.png (asset protocol 로 표시)
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use windows::core::HSTRING;
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY};

/// 캐시된 PNG 경로를 돌려준다(없으면 추출). 호출자는 워커 스레드(spawn_blocking).
pub fn icon(dir: &Path, target: &str) -> Result<PathBuf, String> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    target.to_ascii_lowercase().hash(&mut h);
    // ponytail: DefaultHasher 는 Rust 버전 간 안정성 보장 없음 → 업그레이드 시 캐시 재생성될 뿐(무해)
    let out = dir.join(format!("{:016x}.png", h.finish()));
    if out.exists() {
        return Ok(out);
    }
    let parse = if !target.contains('\\') && target.contains('!') { format!(r"shell:AppsFolder\{target}") } else { target.to_string() };
    let (w, hgt, bgra) = unsafe { extract(&parse) }.map_err(|e| format!("아이콘 추출 실패: {target} ({})", e.message()))?;
    let rgba = unpremultiply(bgra);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = out.with_extension("tmp");
    let f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(f), w, hgt);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().and_then(|mut wr| wr.write_image_data(&rgba)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(out)
}

unsafe fn extract(target: &str) -> windows::core::Result<(u32, u32, Vec<u8>)> {
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let f: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(target), None)?;
    let hbm = f.GetImage(SIZE { cx: 256, cy: 256 }, SIIGBF_ICONONLY)?;
    let mut bm = BITMAP::default();
    GetObjectW(HGDIOBJ(hbm.0), size_of::<BITMAP>() as i32, Some((&mut bm as *mut BITMAP).cast()));
    let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let dc = GetDC(None);
    let n = GetDIBits(dc, hbm, 0, h as u32, Some(buf.as_mut_ptr().cast()), &mut bi, DIB_RGB_COLORS);
    ReleaseDC(None, dc);
    let _ = DeleteObject(HGDIOBJ(hbm.0));
    if n == 0 {
        return Err(windows::core::Error::from_thread());
    }
    Ok((w as u32, h as u32, buf))
}

/// BGRA(premultiplied) → RGBA(straight). 이미 straight 면(채널 > 알파인 픽셀 존재) 순서만 바꾼다.
/// 알파가 전부 0 이면(알파 없는 구형 아이콘) 불투명으로 본다.
fn unpremultiply(mut px: Vec<u8>) -> Vec<u8> {
    let premul = px.chunks_exact(4).all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]);
    let no_alpha = px.chunks_exact(4).all(|p| p[3] == 0);
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2);
        if no_alpha {
            p[3] = 255;
        } else if premul && p[3] > 0 && p[3] < 255 {
            let a = p[3] as u32;
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    px
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpremultiply_alpha() {
        // 반투명 흰색(premul 128,128,128,128) → 255 흰색 유지, 검은 테두리 없음
        assert_eq!(unpremultiply(vec![128, 128, 128, 128]), vec![255, 255, 255, 128]);
        // BGRA → RGBA
        assert_eq!(unpremultiply(vec![10, 20, 30, 255]), vec![30, 20, 10, 255]);
        // 알파 전무 → 불투명
        assert_eq!(unpremultiply(vec![1, 2, 3, 0]), vec![3, 2, 1, 255]);
    }

    /// 수동: HERA_ICON_OUT=<dir> cargo test extract_samples -- --ignored --nocapture
    #[test]
    #[ignore]
    fn extract_samples() {
        let out = PathBuf::from(std::env::var("HERA_ICON_OUT").unwrap());
        let lnk = std::env::var("HERA_LNK").unwrap();
        let exe = std::env::var("HERA_EXE").unwrap_or(r"C:\Windows\explorer.exe".into());
        for t in [r"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", &exe, &lnk] {
            let s = std::time::Instant::now();
            let p = icon(&out, t).unwrap();
            println!("ICON {t} -> {} ({:.0}ms)", p.display(), s.elapsed().as_secs_f64() * 1000.0);
        }
    }
}
