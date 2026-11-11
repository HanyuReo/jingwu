@echo off
chcp 65001 >nul
title Jingwu
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [X] Node.js not found.
    echo      Install Node.js 24 or newer: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\ws" (
    echo Installing dependencies...
    call npm install
)

node server.mjs %*
echo.
pause
