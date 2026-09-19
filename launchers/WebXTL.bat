@echo off
setlocal
cd /d "%~dp0.."

if not defined PORT set "PORT=3000"
set "URL=http://localhost:%PORT%"
set "LOG_FILE=%CD%\.webxtl.log"

where node >nul 2>nul
if errorlevel 1 (
    echo Error: Node.js was not found. Please install it from https://nodejs.org
    pause
    exit /b 1
)

if not exist "%CD%\server.js" (
    echo Error: server.js not found in %CD%
    pause
    exit /b 1
)

rem If the server is already listening, just open the browser.
curl -s -o nul --max-time 1 "%URL%" >nul 2>nul
if not errorlevel 1 (
    echo WebXTL is already running at %URL%
    start "" "%URL%"
    exit /b 0
)

echo Starting WebXTL server on %URL% ...
start "WebXTL Server" /min cmd /c "node server.js > "%LOG_FILE%" 2>&1"

for /l %%i in (1,1,40) do (
    curl -s -o nul --max-time 1 "%URL%" >nul 2>nul
    if not errorlevel 1 goto ready
    timeout /t 1 /nobreak >nul
)

echo Warning: server did not become ready in time. See %LOG_FILE%
pause
exit /b 1

:ready
start "" "%URL%"
exit /b 0
