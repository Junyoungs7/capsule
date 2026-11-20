#!/usr/bin/env bash
# Hera 출시: 서명한 설치 파일 + latest.json (자동 업데이트 피드) 을 만든다.
#   bash scripts/release.sh            (판 번호는 src-tauri/tauri.conf.json · Cargo.toml 에서 먼저 올려 둔다)
# 필요한 것 (저장소 밖):
#   ~/.tauri/hera-updater.key          업데이트 서명 비밀키 (잃으면 기존 설치본이 새 판을 못 받는다)
#   $HERA_RELEASE_DIR/update-base.txt  다운로드 폴더 주소 한 줄 (예: http://<사이트>/downloads/hera) — 사내 주소라 저장소에 넣지 않는다
# 결과: $HERA_RELEASE_DIR/Hera_<판>_x64-setup.exe · .sig · latest.json → 사이트 downloads/hera/ 에 그대로 올리면 된다.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${HERA_RELEASE_DIR:-/d/AI/hera/release}"
BASE="$(tr -d '\r\n' < "$OUT/update-base.txt")"
V="$(python -c "import json;print(json.load(open('src-tauri/tauri.conf.json',encoding='utf-8'))['version'])")"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/hera-updater.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
export HERA_UPDATE_URL="$BASE/latest.json"
for i in 1 2 3; do out=$(npx tauri build 2>&1 | tail -4); echo "$out" | tail -2; echo "$out" | grep -q "setup.exe" && break; done
EXE="src-tauri/target/release/bundle/nsis/Hera_${V}_x64-setup.exe"
[ -f "$EXE.sig" ] || { echo "서명 파일이 없어요: $EXE.sig"; exit 1; }
cp "$EXE" "$EXE.sig" "$OUT/"
python - "$OUT" "$V" "$BASE" <<'PY'
import json, sys, datetime, os
out, v, base = sys.argv[1:4]
name = f"Hera_{v}_x64-setup.exe"
sig = open(os.path.join(out, name + ".sig"), encoding="utf-8").read().strip()
feed = {"version": v, "notes": f"Hera {v}", "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {"windows-x86_64": {"signature": sig, "url": f"{base}/{name}"}}}
json.dump(feed, open(os.path.join(out, "latest.json"), "w", encoding="utf-8"), indent=2)
print("latest.json", v, f"{base}/{name}")
PY
sha256sum "$OUT/Hera_${V}_x64-setup.exe"
