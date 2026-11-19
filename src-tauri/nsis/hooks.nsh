; Hera NSIS 설치 훅 (tauri.conf.json bundle.windows.nsis.installerHooks)
; 예전 버전이 함께 설치했던 AI 연결(MCP) 서버 hera-mcp.exe 는 이제 없다 — 덮어 설치할 때 지운다.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\hera-mcp.exe"
!macroend
