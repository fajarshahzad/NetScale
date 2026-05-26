@echo off
setlocal

set "WSL_DISTRO=Ubuntu"
set "WSL_USER=fajar"

where wsl.exe >nul 2>nul
if errorlevel 1 (
    echo WSL was not found. Install Ubuntu/WSL first, then run this file again.
    pause
    exit /b 1
)

wsl.exe -d %WSL_DISTRO% -u %WSL_USER% -- true >nul 2>nul
if errorlevel 1 (
    echo Could not open WSL as: wsl -d %WSL_DISTRO% -u %WSL_USER%
    echo Make sure Ubuntu is installed and the user "%WSL_USER%" exists.
    echo If Ubuntu is missing, install it with:
    echo wsl --install -d Ubuntu
    pause
    exit /b 1
)

for /f "usebackq delims=" %%i in (`wsl.exe -d %WSL_DISTRO% -u %WSL_USER% -- wslpath -a "%CD%"`) do set "WSL_DIR=%%i"

echo Building NetScale in WSL as %WSL_USER%@%WSL_DISTRO%...
wsl.exe -d %WSL_DISTRO% -u %WSL_USER% -- bash -lc "cd '%WSL_DIR%' && echo Using compiler: && cc --version | head -n 1 && cc src/netscale_server.c -O2 -std=c11 -pthread -o parachess"

if errorlevel 1 (
    echo.
    echo Build failed. In Ubuntu/WSL, install a compiler with:
    echo sudo apt update ^&^& sudo apt install build-essential
    pause
    exit /b 1
)

echo Starting NetScale at http://localhost:8080
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8080'"
wsl.exe -d %WSL_DISTRO% -u %WSL_USER% -- bash -lc "cd '%WSL_DIR%' && ./parachess"

endlocal
