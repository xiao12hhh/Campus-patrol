@echo off
rem Double-click entry point. Delegates to start.ps1 (no Chinese text here on purpose).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
