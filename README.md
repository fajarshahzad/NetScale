# NetScale

NetScale is a high-throughput packet visualizer project based on the provided technical specification. This version keeps the backend in C and uses a browser UI for a clean, easy-to-demo dashboard.

## What It Demonstrates

- Producer-consumer packet pipeline with a bounded circular ring buffer
- Parallel worker threads updating shared analytics
- Sequential vs parallel execution mode comparison
- Live packet stream animation
- Protocol split, top IP talkers, throughput, latency, and packet-drop counters

The backend currently generates realistic synthetic IPv4/TCP/UDP/ICMP traffic so the project can run without WinPcap/libpcap setup. The parser and analytics pipeline are separated so real packet capture can be added later.

## Project Layout

```text
src/
  netscale_server.c   C backend, HTTP server, ring buffer, workers, analytics
public/
  index.html          Dashboard markup
  styles.css          Cute, neat UI styling
  app.js              Live charts, animation, API polling
build.bat             Windows build helper
```

## Build On Windows

Install one C compiler first:

- MSYS2 MinGW-w64 GCC, or
- Visual Studio Build Tools with `cl`

Then run:

```bat
build.bat
```

If using GCC manually:

```bat
gcc -std=c11 -O2 -Wall -Wextra src\netscale_server.c -o netscale.exe -lws2_32
```

If using Visual Studio Developer Prompt:

```bat
cl /std:c11 /O2 /W4 src\netscale_server.c ws2_32.lib /Fe:netscale.exe
```

## Run

```bat
netscale.exe
```

Open:

```text
http://localhost:8080
```

Use the mode switch in the dashboard to compare sequential and parallel behavior.

## Notes For Your PDC Presentation

- Sequential mode intentionally simulates UI/render blocking in the data path, so drops and latency rise.
- Parallel mode uses one producer, multiple workers, a preallocated ring buffer, and atomic counters.
- The UI is decoupled from backend processing and refreshes from `/api/stats`.
