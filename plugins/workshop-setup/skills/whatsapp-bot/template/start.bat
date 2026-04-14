@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WhatsApp Agent

REM --- kill previous instance on port 7654 ---
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :7654 ^| findstr LISTENING') do taskkill /pid %%a /f >nul 2>&1

REM --- check node ---
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js not installed.
    echo Download from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

REM --- check claude ---
where claude >nul 2>&1
if errorlevel 1 (
    echo.
    echo [WARN] Claude CLI not found. Installing globally...
    call npm install -g @anthropic-ai/claude-code
)

REM --- first-run: npm install ---
if not exist node_modules (
    echo.
    echo Installing dependencies (one time, ~30 sec)...
    call npm install --no-fund --no-audit --loglevel=error
)

echo.
echo ============================================
echo    WhatsApp ^<-^> Claude Agent
echo    UI:  http://localhost:7654
echo    Stop: close this window or Ctrl+C
echo ============================================
echo.

node bot.js
pause