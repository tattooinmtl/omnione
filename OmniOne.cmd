@echo off
title OmniOne
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
cd /d "%~dp0app"
start "" /min cmd /c "timeout /t 6 >nul && start http://localhost:5174/app"
npm run dev
