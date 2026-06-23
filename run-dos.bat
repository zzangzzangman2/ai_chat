@echo off
setlocal
cd /d "%~dp0"

REM PowerShell 새 창에서 run-dos.ps1 실행.
REM - 기존엔 cmd 호스트에서 inline 실행이라 wide 이모지 클리핑 버그가 있었음.
REM - PowerShell 새 창은 ConPTY 기반이라 같은 conhost지만, 별개 윈도우라 cmd 잔존 상태와 분리됨.
REM - -NoExit: dos-chat.js 종료 후에도 PowerShell prompt 유지 (오류 메시지 볼 수 있음).
start "ARCA DOS" powershell -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-dos.ps1" %*
exit /b 0
