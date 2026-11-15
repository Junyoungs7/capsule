; Hera NSIS 설치 훅 (tauri.conf.json bundle.windows.nsis.installerHooks)
; AI 연결(MCP) 서버 hera-mcp.exe 를 hera.exe 옆에 설치한다. Tauri 번들러는 주 바이너리만 싣는다 —
; externalBin/resources 는 build.rs 가 빌드 전에 파일 존재를 확인해 깨끗한 빌드에서 실패하므로 여기서 넣는다.
; File 경로는 생성되는 target\release\nsis\x64\installer.nsi 기준 (build.beforeBundleCommand 가 release 로 미리 빌드).
!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File "..\..\hera-mcp.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\hera-mcp.exe"
!macroend
