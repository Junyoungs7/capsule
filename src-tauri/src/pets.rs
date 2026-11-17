// 내 펫 (사용자 이미지 팩): %APPDATA%\Hera\pets\<id>\pet.json + 이미지 (pets/CUSTOM-PETS.md). 이 PC 에만 — 올리지 않는다.
// 들어오는 것(웹뷰가 고른 파일 · .herapet.zip)은 모두 여기서 검사한다: 형식(PNG/APNG · GIF · WebP 머리), 4MB, 프레임 1024px,
// 이미지 8개, 이름은 `<상태>.<확장자>` 만. zip 은 절대 경로 · `..` · 하위 폴더 · 심볼릭 링크 · 모르는 파일을 거절한다.
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const STATES: [&str; 8] = ["idle", "sleep", "chat", "event", "typing", "done", "fail", "shelf"];
const MAX_FILE: usize = 4 << 20;
const MAX_DIM: u32 = 1024;
const MAX_JSON: usize = 16 << 10;
const MAX_ZIP: usize = 8 * MAX_FILE + MAX_JSON + (64 << 10); // ≈ 32MB (zip 머리·목차 여유 64KB)
const _: () = assert!(MAX_ZIP < 40 << 20);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Sheet {
    pub frames: u32,
    pub fps: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Meta {
    pub version: u32,
    pub name: String,
    pub style: String,
    pub states: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<Sheet>,
}

#[derive(Serialize, Debug)]
pub struct Img {
    path: String,
    w: u32,
    h: u32,
    v: u64, // 수정 시각 (같은 이름을 바꿔 써도 웹뷰 캐시가 새로 읽게)
}

#[derive(Serialize, Debug)]
pub struct Pet {
    id: String,
    name: String,
    style: String,
    sheet: Option<Sheet>,
    files: BTreeMap<String, Img>,
}

pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().data_dir().map_err(|e| e.to_string())?.join("Hera").join("pets"))
}

fn le(b: &[u8]) -> u32 {
    b.iter().rev().fold(0, |a, &x| (a << 8) | x as u32)
}

/// 이미지 머리 → (확장자, 폭, 높이). PNG(APNG 포함) · GIF · WebP(VP8 / VP8L / VP8X) 만.
pub fn sniff(b: &[u8]) -> Option<(&'static str, u32, u32)> {
    let (ext, w, h) = if b.len() >= 24 && b.starts_with(b"\x89PNG\r\n\x1a\n") && &b[12..16] == b"IHDR" {
        ("png", u32::from_be_bytes(b[16..20].try_into().ok()?), u32::from_be_bytes(b[20..24].try_into().ok()?))
    } else if b.len() >= 10 && (b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a")) {
        ("gif", le(&b[6..8]), le(&b[8..10]))
    } else if b.len() >= 30 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        match &b[12..16] {
            b"VP8 " if b[23..26] == [0x9d, 0x01, 0x2a] => ("webp", le(&b[26..28]) & 0x3fff, le(&b[28..30]) & 0x3fff),
            b"VP8L" if b[20] == 0x2f => {
                let v = le(&b[21..25]);
                ("webp", (v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1)
            }
            b"VP8X" => ("webp", le(&b[24..27]) + 1, le(&b[27..30]) + 1),
            _ => return None,
        }
    } else {
        return None;
    };
    (w > 0 && h > 0).then_some((ext, w, h))
}

fn valid_id(id: &str) -> bool {
    (4..=16).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// 팩 안 이미지 이름: `<상태>.<png|gif|webp|apng>` 모양의 평범한 이름만 (경로 · `..` · 숨은 파일 없음)
fn valid_file(n: &str) -> bool {
    let Some((stem, ext)) = n.rsplit_once('.') else { return false };
    (1..=32).contains(&stem.len()) && stem.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') && ["png", "gif", "webp", "apng"].contains(&ext.to_ascii_lowercase().as_str())
}

fn clean_name(s: &str) -> Result<String, String> {
    let n = s.trim();
    if n.is_empty() || n.chars().count() > 12 || n.chars().any(char::is_control) {
        return Err("이름은 1~12자로 써 주세요".into());
    }
    Ok(n.to_string())
}

pub fn check_meta(m: &Meta) -> Result<(), String> {
    if m.version != 1 {
        return Err("pet.json은 version 1만 읽을 수 있어요".into());
    }
    clean_name(&m.name)?;
    if m.style != "pixel" && m.style != "smooth" {
        return Err("style = pixel | smooth".into());
    }
    if !m.states.contains_key("idle") {
        return Err("idle 이미지가 필요해요".into());
    }
    for (k, v) in &m.states {
        if !STATES.contains(&k.as_str()) || !valid_file(v) {
            return Err(format!("알 수 없는 상태·파일: {k} = {v}"));
        }
    }
    if let Some(s) = m.sheet {
        if !(1..=64).contains(&s.frames) || !(1..=30).contains(&s.fps) {
            return Err("한 장에 여러 프레임: 1~64장 · 초당 1~30장".into());
        }
    }
    Ok(())
}

/// 한 이미지: 크기 · 형식 · 프레임 크기 (시트면 가로 한 줄 frames 칸)
pub fn check_image(b: &[u8], frames: u32) -> Result<(&'static str, u32, u32), String> {
    if b.len() > MAX_FILE {
        return Err("이미지는 4MB까지 쓸 수 있어요".into());
    }
    let (ext, w, h) = sniff(b).ok_or("PNG · GIF · WebP · APNG만 쓸 수 있어요")?;
    if w / frames.max(1) > MAX_DIM || h > MAX_DIM || w < frames {
        return Err("한 프레임은 1024×1024까지예요".into());
    }
    Ok((ext, w, h))
}

/// 임시 폴더에 다 쓴 뒤 바꿔 넣기 (중간에 실패해도 예전 팩은 그대로)
fn write_pack(root: &Path, id: &str, meta: &Meta, files: &[(String, Vec<u8>)]) -> Result<(), String> {
    let e = |e: std::io::Error| e.to_string();
    let tmp = root.join(format!(".tmp-{id}"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(e)?;
    std::fs::write(tmp.join("pet.json"), serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?).map_err(e)?;
    for (n, b) in files {
        std::fs::write(tmp.join(n), b).map_err(e)?;
    }
    let dst = root.join(id);
    if dst.exists() {
        std::fs::remove_dir_all(&dst).map_err(e)?;
    }
    std::fs::rename(&tmp, &dst).map_err(e)
}

/// 폴더 하나 읽기 (pet.json · 이미지 모두 다시 검사, 링크는 따라가지 않는다)
/// (상태, 바이트, 폭, 높이, 수정 시각)
type PackFile = (String, Vec<u8>, u32, u32, u64);

pub fn read_pack(dir: &Path) -> Result<(Meta, Vec<PackFile>), String> {
    let plain = |p: &Path| std::fs::symlink_metadata(p).map(|m| m.is_file()).unwrap_or(false);
    let j = dir.join("pet.json");
    if !plain(&j) {
        return Err("pet.json 없음".into());
    }
    let raw = std::fs::read(&j).map_err(|e| e.to_string())?;
    if raw.len() > MAX_JSON {
        return Err("pet.json 이 너무 커요".into());
    }
    let meta: Meta = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    check_meta(&meta)?;
    let frames = meta.sheet.map_or(1, |s| s.frames);
    let mut out = vec![];
    for (st, f) in &meta.states {
        let p = dir.join(f);
        if !plain(&p) {
            return Err(format!("{f} 없음"));
        }
        let b = std::fs::read(&p).map_err(|e| e.to_string())?;
        let (_, w, h) = check_image(&b, frames)?;
        let v = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
        out.push((st.clone(), b, w, h, v));
    }
    Ok((meta, out))
}

pub fn list(root: &Path) -> Vec<Pet> {
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    let mut v: Vec<Pet> = rd
        .flatten()
        .filter_map(|e| {
            let id = e.file_name().to_str()?.to_string();
            if !valid_id(&id) || !e.file_type().ok()?.is_dir() {
                return None;
            }
            let (m, files) = read_pack(&e.path()).ok()?;
            let files = files.into_iter().map(|(st, _, w, h, v)| (st.clone(), Img { path: e.path().join(&m.states[&st]).display().to_string(), w, h, v })).collect();
            Some(Pet { id, name: m.name, style: m.style, sheet: m.sheet, files })
        })
        .collect();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v
}

pub fn new_id() -> String {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    let mut n = u64::from_le_bytes(b) | 1 << 40;
    let mut s = Vec::new();
    while n > 0 {
        s.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    String::from_utf8(s).unwrap_or_default().chars().take(10).collect()
}

#[derive(Deserialize)]
struct SaveReq {
    id: Option<String>,
    name: String,
    style: String,
    sheet: Option<Sheet>,
    files: Vec<(String, usize)>, // (상태, 바이트 수) — 몸통 뒤에 차례로
}

/// 저장 몸통 = [u32 LE json 길이][json][이미지 바이트 …] (이미지를 JSON 숫자 배열로 보내지 않게)
pub fn save(root: &Path, body: &[u8]) -> Result<String, String> {
    let n = body.get(..4).map(le).ok_or("빈 요청")? as usize;
    if n > MAX_JSON || body.len() < 4 + n {
        return Err("잘못된 요청".into());
    }
    let req: SaveReq = serde_json::from_slice(&body[4..4 + n]).map_err(|e| e.to_string())?;
    let id = match req.id {
        Some(id) if valid_id(&id) => id,
        Some(_) => return Err("잘못된 펫 id".into()),
        None => new_id(),
    };
    if req.files.len() > STATES.len() || req.files.iter().map(|f| f.1).sum::<usize>() != body.len() - 4 - n {
        return Err("이미지 수·크기가 맞지 않아요".into());
    }
    let frames = req.sheet.map_or(1, |s| s.frames.max(1));
    let (mut at, mut states, mut files) = (4 + n, BTreeMap::new(), vec![]);
    for (st, len) in &req.files {
        let b = &body[at..at + len];
        at += len;
        if !STATES.contains(&st.as_str()) || states.contains_key(st) {
            return Err(format!("알 수 없는 상태 {st}"));
        }
        let (ext, ..) = check_image(b, frames)?;
        let f = format!("{st}.{ext}");
        states.insert(st.clone(), f.clone());
        files.push((f, b.to_vec()));
    }
    let meta = Meta { version: 1, name: clean_name(&req.name)?, style: req.style, states, sheet: req.sheet };
    check_meta(&meta)?;
    write_pack(root, &id, &meta, &files)?;
    Ok(id)
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("잘못된 펫 id".into());
    }
    std::fs::remove_dir_all(root.join(id)).map_err(|e| e.to_string())
}

/* ── .herapet.zip: 쓰기 = 압축 없음(이미지는 이미 압축), 읽기 = 저장/deflate 만 ── */
fn u16le(v: u16) -> [u8; 2] {
    v.to_le_bytes()
}

pub fn zip_write(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    zip_build(entries, false)
}

fn zip_build(entries: &[(String, Vec<u8>)], deflate: bool) -> Vec<u8> {
    let (mut out, mut cd) = (vec![], vec![]);
    for (name, data) in entries {
        let crc = crc32fast::hash(data);
        let packed = if deflate {
            let mut z = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            let _ = std::io::Write::write_all(&mut z, data);
            z.finish().unwrap_or_default()
        } else {
            data.clone()
        };
        let off = out.len() as u32;
        let head = |sig: u32, central: bool| {
            let mut h = sig.to_le_bytes().to_vec();
            if central {
                h.extend(u16le(20)); // made by (DOS)
            }
            h.extend(u16le(20)); // needed
            h.extend(u16le(0x0800)); // UTF-8 이름
            h.extend(u16le(if deflate { 8 } else { 0 }));
            h.extend([0, 0, 0x21, 0]); // 1980-01-01 00:00
            h.extend(crc.to_le_bytes());
            h.extend((packed.len() as u32).to_le_bytes());
            h.extend((data.len() as u32).to_le_bytes());
            h.extend(u16le(name.len() as u16));
            h.extend(u16le(0)); // extra
            if central {
                h.extend([0; 6]); // comment, disk, int attrs
                h.extend(0x20u32.to_le_bytes()); // archive
                h.extend(off.to_le_bytes());
            }
            h.extend(name.as_bytes());
            h
        };
        out.extend(head(0x0403_4b50, false));
        out.extend(&packed);
        cd.extend(head(0x0201_4b50, true));
    }
    let (at, len, n) = (out.len() as u32, cd.len() as u32, entries.len() as u16);
    out.extend(cd);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend([0; 4]);
    out.extend(u16le(n));
    out.extend(u16le(n));
    out.extend(len.to_le_bytes());
    out.extend(at.to_le_bytes());
    out.extend(u16le(0));
    out
}

/// zip 풀기 (메모리 안에서): 평범한 이름의 파일 9개까지, 각 4MB. 그 밖의 것은 모두 거절.
pub fn zip_read(b: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let bad = |m: &str| Err(format!("받을 수 없는 zip: {m}"));
    if b.len() > MAX_ZIP {
        return bad("너무 커요");
    }
    let g = |at: usize, n: usize| b.get(at..at + n).map(le).ok_or("잘렸어요".to_string());
    let eocd = (0..b.len().saturating_sub(21)).rev().take(65_557).find(|&i| b[i..i + 4] == [0x50, 0x4b, 5, 6]).ok_or("zip 이 아니에요")?;
    let (count, mut at) = (g(eocd + 10, 2)? as usize, g(eocd + 16, 4)? as usize);
    if count == 0 || count > STATES.len() + 1 {
        return bad("파일 수");
    }
    let mut out: Vec<(String, Vec<u8>)> = vec![];
    for _ in 0..count {
        if g(at, 4)? != 0x0201_4b50 {
            return bad("목차");
        }
        let (made_by, flags, method) = (g(at + 4, 2)?, g(at + 8, 2)?, g(at + 10, 2)?);
        let (crc, csize, size) = (g(at + 16, 4)?, g(at + 20, 4)? as usize, g(at + 24, 4)? as usize);
        let (nl, xl, cl) = (g(at + 28, 2)? as usize, g(at + 30, 2)? as usize, g(at + 32, 2)? as usize);
        let (attrs, local) = (g(at + 38, 4)?, g(at + 42, 4)? as usize);
        let name = std::str::from_utf8(b.get(at + 46..at + 46 + nl).ok_or("잘렸어요")?).map_err(|_| "이름")?.to_string();
        at += 46 + nl + xl + cl;
        if name != "pet.json" && !valid_file(&name) {
            return bad(&format!("이름 {name:?} (경로 · .. · 폴더는 안 돼요)"));
        }
        if made_by >> 8 == 3 && (attrs >> 16) & 0o170000 == 0o120000 || attrs & 0x400 != 0 {
            return bad(&format!("링크 {name}"));
        }
        if flags & 1 != 0 || (method != 0 && method != 8) {
            return bad("암호·압축 방식");
        }
        if size > MAX_FILE || csize > MAX_FILE + 1024 || out.iter().any(|(n, _)| n.eq_ignore_ascii_case(&name)) {
            return bad(&format!("크기·중복 {name}"));
        }
        if g(local, 4)? != 0x0403_4b50 {
            return bad("머리");
        }
        let start = local + 30 + g(local + 26, 2)? as usize + g(local + 28, 2)? as usize;
        let raw = b.get(start..start + csize).ok_or("잘렸어요")?;
        let data = if method == 0 {
            raw.to_vec()
        } else {
            let mut v = Vec::with_capacity(size);
            flate2::read::DeflateDecoder::new(raw).take(size as u64 + 1).read_to_end(&mut v).map_err(|e| e.to_string())?;
            v
        };
        if data.len() != size || crc32fast::hash(&data) != crc {
            return bad(&format!("손상 {name}"));
        }
        out.push((name, data));
    }
    Ok(out)
}

/// 가져오기: pet.json 과 그 안에 적힌 이미지만 (모르는 파일이 있으면 거절) → 새 id
pub fn import_zip(root: &Path, b: &[u8]) -> Result<String, String> {
    let entries = zip_read(b)?;
    let j = entries.iter().find(|(n, _)| n == "pet.json").ok_or("pet.json 이 없어요")?;
    if j.1.len() > MAX_JSON {
        return Err("pet.json 이 너무 커요".into());
    }
    let meta: Meta = serde_json::from_slice(&j.1).map_err(|e| e.to_string())?;
    check_meta(&meta)?;
    let frames = meta.sheet.map_or(1, |s| s.frames);
    let mut files = vec![];
    for (n, d) in &entries {
        if n == "pet.json" {
            continue;
        }
        if !meta.states.values().any(|v| v == n) {
            return Err(format!("알 수 없는 파일이 들어 있어요: {n}"));
        }
        check_image(d, frames)?;
        files.push((n.clone(), d.clone()));
    }
    if files.len() != meta.states.len() {
        return Err("pet.json에 적힌 이미지가 없어요".into());
    }
    let meta = Meta { name: clean_name(&meta.name)?, ..meta };
    let id = new_id();
    write_pack(root, &id, &meta, &files)?;
    Ok(id)
}

/// 내보내기: 팩 폴더 그대로 (pet.json + 이미지) → (파일 이름, zip 바이트)
pub fn export(root: &Path, id: &str) -> Result<(String, Vec<u8>), String> {
    if !valid_id(id) {
        return Err("잘못된 펫 id".into());
    }
    let (meta, files) = read_pack(&root.join(id))?;
    let mut entries = vec![("pet.json".to_string(), serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?)];
    entries.extend(files.into_iter().map(|(st, b, ..)| (meta.states[&st].clone(), b)));
    let safe: String = meta.name.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    Ok((format!("{safe}.herapet.zip"), zip_write(&entries)))
}

/* ── 커맨드 ── */
fn body(r: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match r.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err("바이트 몸통이 필요해요".into()),
    }
}

#[tauri::command]
pub fn pet_list(app: AppHandle) -> Result<Vec<Pet>, String> {
    Ok(list(&root(&app)?))
}

#[tauri::command]
pub fn pet_save(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let r = root(&app)?;
    std::fs::create_dir_all(&r).map_err(|e| e.to_string())?;
    save(&r, &body(&request)?)
}

#[tauri::command]
pub fn pet_delete(app: AppHandle, id: String) -> Result<(), String> {
    delete(&root(&app)?, &id)
}

#[tauri::command]
pub fn pet_import(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let r = root(&app)?;
    std::fs::create_dir_all(&r).map_err(|e| e.to_string())?;
    import_zip(&r, &body(&request)?)
}

/// 다운로드 폴더에 `<이름>.herapet.zip` (있으면 ` (2)` …) → 경로
#[tauri::command]
pub fn pet_export(app: AppHandle, id: String) -> Result<String, String> {
    let (name, zip) = export(&root(&app)?, &id)?;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let (stem, mut p) = (name.trim_end_matches(".herapet.zip").to_string(), dir.join(&name));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({n}).herapet.zip"));
        n += 1;
    }
    std::fs::write(&p, zip).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b.extend([8, 6, 0, 0, 0]);
        b
    }
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hera-pets-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn body(json: serde_json::Value, files: &[&[u8]]) -> Vec<u8> {
        let j = serde_json::to_vec(&json).unwrap();
        let mut b = (j.len() as u32).to_le_bytes().to_vec();
        b.extend(j);
        files.iter().for_each(|f| b.extend(*f));
        b
    }

    #[test]
    fn sniff_formats() {
        assert_eq!(sniff(&png(16, 14)), Some(("png", 16, 14)));
        assert_eq!(sniff(b"GIF89a\x40\x00\x20\x00rest"), Some(("gif", 64, 32)));
        let mut vp8x = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\x10\0\0\0".to_vec();
        vp8x.extend([0x3f, 0, 0, 0x1f, 0, 0]); // 64 × 32
        assert_eq!(sniff(&vp8x), Some(("webp", 64, 32)));
        let mut vp8l = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f".to_vec();
        vp8l.extend(((15u32) | (13 << 14)).to_le_bytes()); // 16 × 14
        vp8l.extend([0; 8]);
        assert_eq!(sniff(&vp8l), Some(("webp", 16, 14)));
        assert_eq!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None); // SVG · 실행 파일 등은 거절
        assert_eq!(sniff(b"MZ\x90\0\x03\0\0\0\x04\0\0\0\xff\xff\0\0\xb8\0\0\0\0\0\0\0"), None);
        assert_eq!(sniff(&png(0, 14)), None);
    }

    #[test]
    fn limits() {
        assert!(check_image(&png(1024, 1024), 1).is_ok());
        assert!(check_image(&png(1025, 10), 1).is_err());
        assert!(check_image(&png(6 * 1024, 1024), 6).is_ok()); // 시트 6칸 = 칸마다 1024
        assert!(check_image(&png(3, 10), 6).is_err()); // 칸보다 좁음
        let mut big = png(10, 10);
        big.resize(MAX_FILE + 1, 0);
        assert!(check_image(&big, 1).is_err());
        assert!(valid_file("idle.png") && valid_file("my_cat-sleep.GIF"));
        for n in ["../idle.png", "a/idle.png", "C:idle.png", ".idle.png", "idle.svg", "idle.png.exe", "", "idle"] {
            assert!(!valid_file(n), "{n}");
        }
        assert!(valid_id("k3f9a2xq") && !valid_id("..") && !valid_id("K3F9") && !valid_id("a/b/c/d"));
        assert!(clean_name("  말랑이 ").is_ok_and(|n| n == "말랑이") && clean_name("").is_err() && clean_name("열세글자짜리이름입니다아아").is_err());
    }

    #[test]
    fn save_list_edit_delete() {
        let r = tmp("save");
        let (idle, done) = (png(16, 14), png(32, 28));
        let id = save(&r, &body(serde_json::json!({ "name": "말랑이", "style": "pixel", "sheet": null, "files": [["idle", idle.len()], ["done", done.len()]] }), &[&idle, &done])).unwrap();
        let l = list(&r);
        assert_eq!(l.len(), 1);
        assert_eq!((l[0].name.as_str(), l[0].style.as_str(), l[0].files.len()), ("말랑이", "pixel", 2));
        assert_eq!((l[0].files["done"].w, l[0].files["done"].h), (32, 28));
        assert!(r.join(&id).join("idle.png").is_file() && r.join(&id).join("pet.json").is_file());
        // 편집(이름 바꾸기 · 상태 하나 빼기) = 같은 id 로 다시 저장
        save(&r, &body(serde_json::json!({ "id": id, "name": "새 이름", "style": "smooth", "files": [["idle", idle.len()]] }), &[&idle])).unwrap();
        let l = list(&r);
        assert_eq!((l.len(), l[0].name.as_str(), l[0].files.len()), (1, "새 이름", 1));
        assert!(!r.join(&id).join("done.png").exists());
        // idle 없음 · 모르는 상태 · 길이 불일치 · 가짜 이미지 · 이상한 id 는 거절, 폴더도 안 생긴다
        assert!(save(&r, &body(serde_json::json!({ "name": "x", "style": "pixel", "files": [["done", done.len()]] }), &[&done])).is_err());
        assert!(save(&r, &body(serde_json::json!({ "name": "x", "style": "pixel", "files": [["dance", idle.len()]] }), &[&idle])).is_err());
        assert!(save(&r, &body(serde_json::json!({ "name": "x", "style": "pixel", "files": [["idle", 3]] }), &[&idle])).is_err());
        assert!(save(&r, &body(serde_json::json!({ "name": "x", "style": "pixel", "files": [["idle", 4]] }), &[b"MZ\x90\0"])).is_err());
        assert!(save(&r, &body(serde_json::json!({ "id": "../../x", "name": "x", "style": "pixel", "files": [["idle", idle.len()]] }), &[&idle])).is_err());
        assert_eq!(list(&r).len(), 1);
        delete(&r, &id).unwrap();
        assert!(list(&r).is_empty());
        assert!(delete(&r, "..").is_err());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn zip_round_trip_and_rejects() {
        let r = tmp("zip");
        let idle = png(16, 14);
        let id = save(&r, &body(serde_json::json!({ "name": "펭펭", "style": "pixel", "sheet": { "frames": 2, "fps": 8 }, "files": [["idle", idle.len()]] }), &[&idle])).unwrap();
        let (name, zip) = export(&r, &id).unwrap();
        assert_eq!(name, "펭펭.herapet.zip");
        let id2 = import_zip(&r, &zip).unwrap();
        assert_ne!(id, id2);
        let l = list(&r);
        assert_eq!(l.len(), 2);
        assert!(l.iter().all(|p| p.name == "펭펭" && p.sheet == Some(Sheet { frames: 2, fps: 8 })));
        let meta = br#"{"version":1,"name":"x","style":"pixel","states":{"idle":"idle.png"}}"#.to_vec();
        let pack = |extra: Vec<(String, Vec<u8>)>| {
            let mut e = vec![("pet.json".to_string(), meta.clone()), ("idle.png".to_string(), idle.clone())];
            e.extend(extra);
            zip_write(&e)
        };
        assert!(import_zip(&r, &pack(vec![])).is_ok());
        for (bad, why) in [
            (pack(vec![("../evil.png".into(), idle.clone())]), "dotdot"),
            (pack(vec![("C:/Windows/evil.png".into(), idle.clone())]), "absolute"),
            (pack(vec![("/etc/evil.png".into(), idle.clone())]), "root"),
            (pack(vec![("sub/idle.png".into(), idle.clone())]), "folder"),
            (pack(vec![("readme.txt".into(), b"hi".to_vec())]), "unknown type"),
            (pack(vec![("sleep.png".into(), idle.clone())]), "unlisted file"),
            (zip_write(&[("pet.json".into(), meta.clone())]), "missing image"),
            (zip_write(&[("pet.json".into(), meta.clone()), ("idle.png".into(), b"MZ\x90\0not an image".to_vec())]), "fake image"),
            (b"PK\x03\x04garbage".to_vec(), "not a zip"),
        ] {
            assert!(import_zip(&r, &bad).is_err(), "{why} accepted");
        }
        // 심볼릭 링크 (unix 모드 0o120777 · made-by 3)
        let mut link = pack(vec![]);
        let cd = (0..link.len() - 4).rev().find(|&i| link[i..i + 4] == [0x50, 0x4b, 1, 2]).unwrap();
        link[cd + 5] = 3;
        link[cd + 40..cd + 42].copy_from_slice(&0o120777u16.to_le_bytes());
        assert!(import_zip(&r, &link).unwrap_err().contains("링크"));
        // 큰 파일 (4MB 초과)
        let mut big = idle.clone();
        big.resize(MAX_FILE + 10, 0);
        assert!(import_zip(&r, &zip_write(&[("pet.json".into(), meta.clone()), ("idle.png".into(), big)])).is_err());
        assert!(zip_read(&vec![0u8; MAX_ZIP + 1]).unwrap_err().contains("너무 커요")); // 전체 크기 상한 (≈ 32MB)
        // deflate 로 묶은 zip 도 읽는다 (다른 도구로 만든 팩)
        assert!(import_zip(&r, &zip_build(&[("pet.json".into(), meta.clone()), ("idle.png".into(), idle.clone())], true)).is_ok());
        let _ = std::fs::remove_dir_all(&r);
    }
}
