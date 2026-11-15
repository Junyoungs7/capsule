@echo off
rem Fake ARA CLI for term-cdp.mjs (HERA_ARA_CLI) - never touches the real ARA. Logs "cwd | args".
>>"%TEMP%\hera-fake-ara.log" echo %CD% ^| %*
if "%1"=="status" (echo {"ok":true,"result":{"app":{"running":false}}}& exit /b 0)
if "%1"=="open" (echo {"ok":true,"result":{"app":{"running":true}}}& exit /b 0)
echo {"ok":true,"result":{"terminal":{"id":"fake-1"}}}
