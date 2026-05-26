@echo off
setlocal

where gcc >nul 2>nul
if %errorlevel%==0 (
  gcc -std=c11 -O2 -Wall -Wextra src\netscale_server.c -o netscale.exe -lws2_32
  exit /b %errorlevel%
)

where cl >nul 2>nul
if %errorlevel%==0 (
  cl /std:c11 /O2 /W4 src\netscale_server.c ws2_32.lib /Fe:netscale.exe
  exit /b %errorlevel%
)

echo No C compiler found. Install MSYS2 MinGW-w64 GCC or run this from a Visual Studio Developer Prompt.
exit /b 1
