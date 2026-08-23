@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WhatsApp Claude Agent
set "PIDFILE=%CD%\.bot.pid"
set "BOTDIR=%CD%"

if exist "%PIDFILE%" (
  powershell -NoProfile -Command "$id=0; $text=Get-Content -LiteralPath $env:PIDFILE -Raw; if([int]::TryParse($text.Trim(),[ref]$id)){$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id) -ErrorAction SilentlyContinue; if($p -and $p.CommandLine -like ('*' + $env:BOTDIR + '\hub.js*')){Stop-Process -Id $id -Force}}" >nul 2>&1
  del "%PIDFILE%" >nul 2>&1
)

REM If a previous hub.js was killed without running its own shutdown (window
REM force-closed, process killed outside this script, etc.), its per-account
REM bot.js children can be left running - no PID file tracks them, and each
REM still holds its port and its live WhatsApp connection. Find them by
REM command line and stop them before a fresh hub starts, otherwise the new
REM hub either collides with their ports or spawns duplicate accounts.
powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like ('*' + $env:BOTDIR + '\bot.js*') }; if ($procs) { Write-Host 'Stopping stale per-account processes left over from a previous run (it may have closed without a clean shutdown):'; foreach ($p in $procs) { Write-Host ('   PID ' + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":7654 " ^| findstr LISTENING') do (
  echo.
  echo [ERROR] Port 7654 is already used by another program. It was not stopped.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed. Download it from https://nodejs.org
  pause
  exit /b 1
)

where claude >nul 2>&1
if errorlevel 1 (
  echo.
  echo [WARN] Claude Code was not found. Installing it now...
  call npm install --ignore-scripts -g @anthropic-ai/claude-code
  if errorlevel 1 exit /b 1
)

if not exist node_modules (
  echo.
  echo Installing components for the first time...
  call npm install --ignore-scripts --no-fund --no-audit --loglevel=error
  if errorlevel 1 exit /b 1
)

echo.
echo ============================================
echo    WhatsApp ^<-^> Claude Agent
echo    UI: http://127.0.0.1:7654
echo    Stop: close this window or press Ctrl+C
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$script=[char]34 + $env:BOTDIR + '\hub.js' + [char]34; $p=Start-Process node -ArgumentList $script -WorkingDirectory $env:BOTDIR -NoNewWindow -PassThru; Set-Content -LiteralPath $env:PIDFILE -Value $p.Id; try{$p.WaitForExit(); exit $p.ExitCode}finally{Remove-Item -LiteralPath $env:PIDFILE -Force -ErrorAction SilentlyContinue}"
pause
