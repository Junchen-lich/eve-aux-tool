@echo off
rem ============================================================
rem  EVE Auxiliary Tool - single entry point (Windows)
rem  Double-click to open the interactive console.
rem
rem  This file is intentionally pure ASCII: cmd.exe mis-handles
rem  UTF-8 Chinese in batch files. All Chinese text is printed
rem  by scripts\launch.js instead.
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found.
  echo       Please install Node.js 18+ from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node scripts\launch.js %*
set RC=%ERRORLEVEL%

if not "%RC%"=="0" (
  echo.
  echo   [!] Exit code %RC% - see messages above.
  echo.
  pause
)
endlocal
