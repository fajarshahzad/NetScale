# NetScale Project Report

## PDF Analysis Summary

The provided specification describes **NetScale**, a high-throughput network packet visualizer that demonstrates why a sequential packet-processing loop fails under heavy traffic and how a parallel producer-consumer pipeline solves that bottleneck.

Important requirements from the PDF:

- Process up to 1,000,000 packets per second conceptually.
- Show the packet-drop wall in sequential execution.
- Use a producer-consumer pipeline with a circular ring buffer.
- Run parser workers independently from the UI renderer.
- Maintain shared analytics through atomic counters.
- Display a dashboard with:
  - live packet stream,
  - TCP/UDP/ICMP protocol split,
  - top IP talkers,
  - throughput,
  - sequential vs parallel latency,
  - packet drops.

## Implemented System

This project implements the same architecture with a pure C backend and a browser-based UI.

### Backend

File: `src/netscale_server.c`

- Language: C11
- Server: lightweight HTTP server using sockets
- Parallelism:
  - one producer thread,
  - four worker threads,
  - bounded ring buffer,
  - atomic analytics counters
- Traffic source: synthetic packet generator
- APIs:
  - `/api/stats`
  - `/api/mode?value=parallel`
  - `/api/mode?value=sequential`

### UI

Files:

- `public/index.html`
- `public/styles.css`
- `public/app.js`

The UI includes:

- cute, clean dashboard layout,
- animated packet stream canvas,
- protocol pie chart,
- top talkers chart,
- performance metrics,
- mode switch for sequential/parallel comparison.

## Architecture

```text
Synthetic Packet Source
        |
        v
Producer Thread
        |
        v
Lock-Free Bounded Ring Buffer
        |
        v
Worker Thread Pool
        |
        v
Atomic Global Analytics
        |
        v
Browser Dashboard
```

## Sequential Mode

Sequential mode intentionally simulates the failure pattern described in the PDF:

```text
Capture -> Parse -> Analytics -> Render Delay -> More Capture
```

Because rendering delay is placed in the processing path, packet drops rise and latency becomes much higher.

## Parallel Mode

Parallel mode decouples packet production, parsing, analytics, and rendering:

```text
Capture -> Ring Buffer -> Worker Pool -> Atomic Analytics
                                     -> UI polls snapshot
```

This keeps packet drops near zero and keeps the dashboard responsive.

## Complexity

Sequential:

```text
O(N * T_parse + N * T_render)
```

Parallel:

```text
O((N * T_parse) / P + C)
```

Where:

- `N` is packet count,
- `P` is worker count,
- `C` is constant UI polling/rendering cost.

## Future Extensions

- Replace synthetic traffic with real `.pcap` file parsing.
- Add WinPcap/Npcap or libpcap live capture.
- Add more protocol decoding fields.
- Store historical performance samples for timeline graphs.
