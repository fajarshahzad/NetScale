// Helper: Query selector shortcut
const $ = (id) => document.getElementById(id);

// Global State
const state = {
  activeTab: "broadcast", // 'broadcast' | 'unicast' | 'msgpassing'
  mode: "parallel",       // 'parallel' | 'sequential'
  
  // Custom Packet Injector configuration
  packetSize: 1500,
  protocol: "TCP",
  srcNode: "",
  dstNode: "",
  
  // Simulated Analytics
  stats: {
    processed: 0,
    drops: 0,
    throughput: 0,
    seqLatencyUs: 15400, // 15.4 ms initial sequential latency
    parLatencyUs: 12,    // 12 us initial parallel latency
  },
  
  // Active packets in simulation path
  packetsInFlight: [],
  // Buffered queue for Sequential mode
  sequentialQueue: [],
  
  // Wireshark logs
  captureLog: [],
  selectedPacketId: null,
  
  // Node list configuration
  nodes: {
    broadcast: [
      { id: "Host_A", name: "Host A (Sender)", ip: "192.168.1.10", mac: "00:50:56:c0:00:01", x: 120, y: 120, role: "host", count: 0 },
      { id: "Host_B", name: "Host B (Receiver)", ip: "192.168.1.11", mac: "00:50:56:c0:00:02", x: 680, y: 120, role: "host", count: 0 },
      { id: "Host_C", name: "Host C (Receiver)", ip: "192.168.1.12", mac: "00:50:56:c0:00:03", x: 120, y: 320, role: "host", count: 0 },
      { id: "Host_D", name: "Host D (Receiver)", ip: "192.168.1.13", mac: "00:50:56:c0:00:04", x: 680, y: 320, role: "host", count: 0 },
      { id: "Switch_1", name: "Core Switch", ip: "192.168.1.1", mac: "00:10:fa:83:bc:01", x: 400, y: 220, role: "switch", count: 0 }
    ],
    unicast: [
      { id: "Host_A", name: "Host A", ip: "10.0.1.10", mac: "00:aa:bb:cc:dd:01", x: 100, y: 120, role: "host", count: 0 },
      { id: "Switch_1", name: "Local Switch", ip: "10.0.1.1", mac: "00:11:22:33:44:01", x: 260, y: 120, role: "switch", count: 0 },
      { id: "Router_1", name: "Gateway Router", ip: "10.0.1.254", mac: "00:22:33:44:55:01", x: 400, y: 220, role: "router", count: 0 },
      { id: "Switch_2", name: "Remote Switch", ip: "10.0.2.1", mac: "00:11:22:33:44:02", x: 540, y: 320, role: "switch", count: 0 },
      { id: "Host_B", name: "Host B", ip: "10.0.2.20", mac: "00:aa:bb:cc:dd:02", x: 700, y: 320, role: "host", count: 0 }
    ],
    msgpassing: [
      { id: "MPI_0", name: "MPI Node 0", ip: "172.16.0.1", mac: "52:54:00:12:34:01", x: 400, y: 80, role: "host", count: 0 },
      { id: "MPI_1", name: "MPI Node 1", ip: "172.16.0.2", mac: "52:54:00:12:34:02", x: 650, y: 220, role: "host", count: 0 },
      { id: "MPI_2", name: "MPI Node 2", ip: "172.16.0.3", mac: "52:54:00:12:34:03", x: 400, y: 360, role: "host", count: 0 },
      { id: "MPI_3", name: "MPI Node 3", ip: "172.16.0.4", mac: "52:54:00:12:34:04", x: 150, y: 220, role: "host", count: 0 }
    ]
  }
};

// Colors mapping matching the CSS bright high-contrast theme
const themeColors = {
  TCP: "#e11d48",   // vibrant rose
  UDP: "#0284c7",   // deep sky blue
  ICMP: "#059669",  // emerald green
  neutral: "#64748b"
};

// Start initialization
window.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  changeTab("broadcast");
  populateSelectors();
  updateAnalyticsUI();
  updateActiveNodeList();
  
  // Start canvas animation loop
  const canvas = $("networkCanvas");
  const ctx = canvas.getContext("2d");
  
  function frame() {
    drawTopology(ctx, canvas);
    updatePackets();
    requestAnimationFrame(frame);
  }
  
  requestAnimationFrame(frame);
  
  // Background stats fetch (keep backend compatible if active)
  setInterval(pollBackendStats, 1000);
});

// Setup DOM event listeners
function setupEventListeners() {
  // Tab selectors (the three panels)
  $("tab-broadcast").addEventListener("click", () => changeTab("broadcast"));
  $("tab-unicast").addEventListener("click", () => changeTab("unicast"));
  $("tab-msgpassing").addEventListener("click", () => changeTab("msgpassing"));
  
  // Pipeline Mode buttons
  $("parallelBtn").addEventListener("click", () => togglePipelineMode("parallel"));
  $("sequentialBtn").addEventListener("click", () => togglePipelineMode("sequential"));
  
  // Size preset selectors
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
      e.target.classList.add("active");
      const size = parseInt(e.target.dataset.size);
      state.packetSize = size;
      $("customPacketSize").value = size;
    });
  });
  
  $("customPacketSize").addEventListener("input", (e) => {
    state.packetSize = parseInt(e.target.value) || 1500;
  });
  
  // Protocol and selectors
  $("packetProto").addEventListener("change", (e) => {
    state.protocol = e.target.value;
  });
  
  $("srcNode").addEventListener("change", (e) => {
    state.srcNode = e.target.value;
  });
  
  $("dstNode").addEventListener("change", (e) => {
    state.dstNode = e.target.value;
  });
  
  // Action triggers
  $("injectBtn").addEventListener("click", triggerPacketInjection);
  $("clearStatsBtn").addEventListener("click", clearAnalytics);
  $("clearCaptureBtn").addEventListener("click", clearWiresharkCapture);
}

// Switching Tabs / panels
function changeTab(tabName) {
  state.activeTab = tabName;
  state.packetsInFlight = [];
  state.sequentialQueue = [];
  
  // UI Tabs update
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));
  $(`tab-${tabName}`).classList.add("active");
  
  // Adjust control elements depending on tab
  if (tabName === "broadcast") {
    $("dstNodeGroup").style.opacity = "0.5";
    $("dstNode").disabled = true;
  } else {
    $("dstNodeGroup").style.opacity = "1";
    $("dstNode").disabled = false;
  }
  
  populateSelectors();
  updateActiveNodeList();
}

// Populate Src/Dst Selectors based on Active Tab nodes
function populateSelectors() {
  const currentNodes = state.nodes[state.activeTab].filter(n => n.role === "host");
  const srcSelect = $("srcNode");
  const dstSelect = $("dstNode");
  
  srcSelect.innerHTML = "";
  dstSelect.innerHTML = "";
  
  currentNodes.forEach((node, index) => {
    srcSelect.appendChild(new Option(node.name, node.id));
    dstSelect.appendChild(new Option(node.name, node.id));
  });
  
  // Default values
  if (currentNodes.length > 1) {
    dstSelect.selectedIndex = 1;
  }
  
  state.srcNode = srcSelect.value;
  state.dstNode = dstSelect.value;
}

// Toggle parallel/sequential
async function togglePipelineMode(mode) {
  state.mode = mode;
  $("parallelBtn").classList.toggle("active", mode === "parallel");
  $("sequentialBtn").classList.toggle("active", mode === "sequential");
  
  // Notify backend API if running
  try {
    await fetch(`/api/mode?value=${mode}`);
  } catch (e) {
    // Ignore server connection error in frontend standalone mode
  }
}

// Format numbers
function formatCompact(num) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(num);
}

// Refresh top dashboard numbers
function updateAnalyticsUI() {
  $("processed").textContent = formatCompact(state.stats.processed);
  $("drops").textContent = formatCompact(state.stats.drops);
  $("throughput").textContent = `${formatCompact(state.stats.throughput)} pkt/s`;
  
  const seqLatency = state.stats.seqLatencyUs || 0;
  const parLatency = state.stats.parLatencyUs || 1; // absolute minimum to prevent division by zero
  
  // Format Latencies
  const seqMs = (seqLatency / 1000).toFixed(2);
  $("seqLatency").textContent = `${seqMs} ms`;
  $("parLatency").textContent = `${parLatency} us`;
  
  // Calculate speedup
  const speedup = seqLatency / parLatency;
  $("speedupVal").textContent = `${speedup.toFixed(1)}x`;
}

// Sidebar live diagnostics
function updateActiveNodeList() {
  const container = $("nodeStatusList");
  container.innerHTML = "";
  
  const currentNodes = state.nodes[state.activeTab];
  currentNodes.forEach((n) => {
    const isNodeBusy = state.packetsInFlight.some(p => p.currentNodeId === n.id);
    const row = document.createElement("div");
    row.className = "node-status-row";
    row.innerHTML = `
      <div class="node-info">
        <span class="node-dot ${isNodeBusy ? '' : 'idle'}"></span>
        <span class="node-name">${n.name}</span>
      </div>
      <span class="node-stat">${formatCompact(n.count)} rx</span>
    `;
    container.appendChild(row);
  });
}

// Inject Packet execution
function triggerPacketInjection() {
  const src = state.nodes[state.activeTab].find(n => n.id === state.srcNode);
  const dst = state.nodes[state.activeTab].find(n => n.id === state.dstNode);
  if (!src) return;
  
  // Dynamically calculate packet speed based on size (jumbo frames travel slightly slower due to serialization delay)
  const sizeFactor = Math.max(0.4, 1.2 - (state.packetSize / 9500));
  const baseSpeed = state.mode === "parallel" ? 3.5 * sizeFactor : 0.85 * sizeFactor;
  
  // Create simulation pathways based on mode
  let pathNodes = [];
  
  if (state.activeTab === "broadcast") {
    // Host -> Switch -> All other Hosts
    const switchNode = state.nodes[state.activeTab].find(n => n.role === "switch");
    const otherHosts = state.nodes[state.activeTab].filter(n => n.role === "host" && n.id !== src.id);
    
    // Inject first segment: Src Host to switch
    const mainPacket = {
      id: Date.now() + Math.random(),
      src: src,
      dst: switchNode,
      proto: state.protocol,
      size: state.packetSize,
      speed: baseSpeed,
      progress: 0,
      phase: 1, // Phase 1: Host to switch, Phase 2: broadcast out
      targets: otherHosts,
      currentNodeId: src.id
    };
    
    injectOrQueue(mainPacket);
  } 
  else if (state.activeTab === "unicast") {
    // Unicast: Host A -> Switch 1 -> Router 1 -> Router 2 / Switch 2 -> Host B
    const allNodes = state.nodes[state.activeTab];
    // Find absolute index of src and dst in unicast layout
    const srcIndex = allNodes.findIndex(n => n.id === src.id);
    const dstIndex = allNodes.findIndex(n => n.id === dst.id);
    
    let path = [];
    if (srcIndex < dstIndex) {
      path = allNodes.slice(srcIndex, dstIndex + 1);
    } else {
      path = allNodes.slice(dstIndex, srcIndex + 1).reverse();
    }
    
    if (path.length > 1) {
      const packet = {
        id: Date.now() + Math.random(),
        src: path[0],
        dst: path[1],
        proto: state.protocol,
        size: state.packetSize,
        speed: baseSpeed,
        progress: 0,
        path: path,
        pathStep: 1,
        currentNodeId: path[0].id
      };
      injectOrQueue(packet);
    }
  } 
  else if (state.activeTab === "msgpassing") {
    // Ring topology: Node 0 -> Node 1 -> Node 2 -> Node 3 -> Node 0
    const allNodes = state.nodes[state.activeTab];
    const srcIndex = allNodes.findIndex(n => n.id === src.id);
    const dstIndex = allNodes.findIndex(n => n.id === dst.id);
    
    // MPI message routing: traverse around the ring topology
    let path = [];
    let idx = srcIndex;
    while (true) {
      path.push(allNodes[idx]);
      if (idx === dstIndex) break;
      idx = (idx + 1) % allNodes.length;
    }
    
    if (path.length > 1) {
      const packet = {
        id: Date.now() + Math.random(),
        src: path[0],
        dst: path[1],
        proto: state.protocol,
        size: state.packetSize,
        speed: baseSpeed,
        progress: 0,
        path: path,
        pathStep: 1,
        currentNodeId: path[0].id
      };
      injectOrQueue(packet);
    }
  }
}

// Add to active simulation list or stack into sequential line-ups
function injectOrQueue(pkt) {
  if (state.mode === "parallel") {
    state.packetsInFlight.push(pkt);
  } else {
    // Sequential mode: only one packet allowed on the network at a time!
    if (state.packetsInFlight.length === 0) {
      state.packetsInFlight.push(pkt);
    } else {
      state.sequentialQueue.push(pkt);
      state.stats.drops += 1; // Drop rate increases due to lack of buffer queue threads
      updateAnalyticsUI();
    }
  }
}

// Packet coordinates and animation updates
function updatePackets() {
  for (let i = state.packetsInFlight.length - 1; i >= 0; i--) {
    const p = state.packetsInFlight[i];
    p.progress += p.speed / 100;
    
    if (p.progress >= 1) {
      // Packet reached its current target
      p.currentNodeId = p.dst.id;
      p.dst.count += 1;
      
      // Handle topology specific multi-hops
      if (state.activeTab === "broadcast" && p.phase === 1) {
        // Core Switch reached, spawn broadcast packets to all targets
        state.packetsInFlight.splice(i, 1);
        p.targets.forEach((target) => {
          state.packetsInFlight.push({
            id: Date.now() + Math.random(),
            src: p.dst, // Core switch
            dst: target,
            proto: p.proto,
            size: p.size,
            speed: p.speed,
            progress: 0,
            phase: 2,
            currentNodeId: p.dst.id
          });
        });
        continue;
      }
      
      if (p.path && p.pathStep < p.path.length - 1) {
        // Multi-hop unicast or ring: proceed to next hop
        p.src = p.path[p.pathStep];
        p.pathStep += 1;
        p.dst = p.path[p.pathStep];
        p.progress = 0;
        p.currentNodeId = p.src.id;
        continue;
      }
      
      // Completely processed!
      state.packetsInFlight.splice(i, 1);
      state.stats.processed += 1;
      
      // Wireshark log injection
      logToWireshark(p.src, p.dst, p.proto, p.size);
      
      // Parallel throughput calculation
      state.stats.throughput = Math.ceil(state.stats.processed / (performance.now() / 1500));
      
      // Dynamic adjustments of performance metrics
      if (state.mode === "parallel") {
        state.stats.parLatencyUs = Math.max(5, Math.ceil(12 + (p.size / 700) + Math.random() * 4));
      } else {
        state.stats.seqLatencyUs = Math.max(12000, Math.ceil(15000 + (p.size * 3) + Math.random() * 1200));
      }
      
      updateAnalyticsUI();
      updateActiveNodeList();
      
      // If sequential queue has waiting packets, release next one
      if (state.mode === "sequential" && state.sequentialQueue.length > 0) {
        const nextPacket = state.sequentialQueue.shift();
        nextPacket.id = Date.now() + Math.random();
        state.packetsInFlight.push(nextPacket);
      }
    }
  }
}

// Render node topologies and animations on HTML5 Canvas
function drawTopology(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const activeNodes = state.nodes[state.activeTab];
  
  // 1. Draw connection links
  ctx.lineWidth = 2.5;
  if (state.activeTab === "broadcast") {
    const sw = activeNodes.find(n => n.role === "switch");
    activeNodes.forEach((node) => {
      if (node.id !== sw.id) {
        drawLink(ctx, node.x, node.y, sw.x, sw.y, false);
      }
    });
  } 
  else if (state.activeTab === "unicast") {
    for (let i = 0; i < activeNodes.length - 1; i++) {
      drawLink(ctx, activeNodes[i].x, activeNodes[i].y, activeNodes[i + 1].x, activeNodes[i + 1].y, false);
    }
  } 
  else if (state.activeTab === "msgpassing") {
    for (let i = 0; i < activeNodes.length; i++) {
      const current = activeNodes[i];
      const next = activeNodes[(i + 1) % activeNodes.length];
      drawLink(ctx, current.x, current.y, next.x, next.y, true); // arrowed links
    }
  }
  
  // 2. Draw nodes (switches, routers, hosts)
  activeNodes.forEach((node) => {
    drawNode(ctx, node);
  });
  
  // 3. Draw moving packets in flight
  state.packetsInFlight.forEach((p) => {
    const dx = p.dst.x - p.src.x;
    const dy = p.dst.y - p.src.y;
    const px = p.src.x + dx * p.progress;
    const py = p.src.y + dy * p.progress;
    
    // Draw packet bubble: size of bubble scales with packet size configured
    const sizeRadius = Math.max(6, Math.min(18, 5 + (p.size / 650)));
    const color = themeColors[p.proto] || themeColors.neutral;
    
    ctx.beginPath();
    ctx.arc(px, py, sizeRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowBlur = 14;
    ctx.shadowColor = color;
    ctx.fill();
    ctx.shadowBlur = 0; // reset
    
    // Inner outline
    ctx.beginPath();
    ctx.arc(px, py, sizeRadius - 2, 0, Math.PI * 2);
    ctx.strokeStyle = "#020617";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    
    // Protocol abbreviation text inside packet
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 8px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.proto, px, py + 0.5);
  });
  
  // 4. Draw queue visual indicators for sequential blocked mode
  if (state.mode === "sequential" && state.sequentialQueue.length > 0) {
    ctx.fillStyle = "#f43f5e";
    ctx.font = "bold 11px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(`[Queue Blocked: ${state.sequentialQueue.length} pkts]`, 20, 30);
  }
}

// Draw line between nodes
function drawLink(ctx, x1, y1, x2, y2, withArrow = false) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = "rgba(15, 23, 42, 0.12)";
  ctx.stroke();
  
  // Pipelining flow micro-pulses
  const pulsePhase = (performance.now() / 250) % 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const mx = x1 + dx * pulsePhase;
  const my = y1 + dy * pulsePhase;
  
  ctx.beginPath();
  ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(2, 132, 199, 0.55)";
  ctx.fill();
  
  if (withArrow) {
    const angle = Math.atan2(dy, dx);
    const arrowSize = 8;
    // Midpoint arrow
    const midX = x1 + dx * 0.5;
    const midY = y1 + dy * 0.5;
    
    ctx.beginPath();
    ctx.moveTo(midX, midY);
    ctx.lineTo(midX - arrowSize * Math.cos(angle - Math.PI / 6), midY - arrowSize * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(midX - arrowSize * Math.cos(angle + Math.PI / 6), midY - arrowSize * Math.sin(angle + Math.PI / 6));
    ctx.fillStyle = "rgba(15, 23, 42, 0.25)";
    ctx.fill();
  }
}

// Draw Node components on Canvas
function drawNode(ctx, node) {
  const r = 24;
  
  // Box shadows / glow
  ctx.shadowBlur = 10;
  ctx.shadowColor = "rgba(15, 23, 42, 0.12)";
  
  if (node.role === "router") {
    // Circle shape for Router (like Cisco layout)
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = varColor("--neon-amber");
    ctx.lineWidth = 2.5;
    ctx.fill();
    ctx.stroke();
    
    // Draw arrows
    ctx.strokeStyle = varColor("--neon-amber");
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(node.x - 10, node.y);
    ctx.lineTo(node.x + 10, node.y);
    ctx.moveTo(node.x, node.y - 10);
    ctx.lineTo(node.x, node.y + 10);
    ctx.stroke();
  } 
  else if (node.role === "switch") {
    // Square/Rectangle box for Switch
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = varColor("--neon-blue");
    ctx.lineWidth = 2.5;
    ctx.fillRect(node.x - 24, node.y - 18, 48, 36);
    ctx.strokeRect(node.x - 24, node.y - 18, 48, 36);
    
    // Inner grid ports
    ctx.fillStyle = "rgba(15, 23, 42, 0.25)";
    for (let x = -16; x <= 16; x += 8) {
      ctx.fillRect(node.x + x - 2, node.y - 6, 4, 4);
      ctx.fillRect(node.x + x - 2, node.y + 2, 4, 4);
    }
  } 
  else {
    // End Host workstation stack
    ctx.beginPath();
    ctx.arc(node.x, node.y, r - 2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    
    // Inside stack server representation
    ctx.fillStyle = "rgba(15, 23, 42, 0.15)";
    ctx.fillRect(node.x - 10, node.y - 8, 20, 3);
    ctx.fillRect(node.x - 10, node.y - 2, 20, 3);
    ctx.fillRect(node.x - 10, node.y + 4, 20, 3);
    // server green light
    ctx.fillStyle = varColor("--neon-green");
    ctx.beginPath();
    ctx.arc(node.x + 6, node.y - 6.5, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  
  ctx.shadowBlur = 0; // reset
  
  // Node Titles
  ctx.fillStyle = "#0f172a";
  ctx.font = "bold 11px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(node.name, node.x, node.y + 36);
  
  ctx.fillStyle = "#64748b";
  ctx.font = "9px system-ui";
  ctx.fillText(node.ip, node.x, node.y + 48);
}

function varColor(cssVar) {
  if (cssVar.includes("neon-blue")) return "#0284c7";
  if (cssVar.includes("neon-green")) return "#059669";
  if (cssVar.includes("neon-rose")) return "#e11d48";
  if (cssVar.includes("neon-amber")) return "#d97706";
  return "#ffffff";
}

// Wireshark Logger helper
function logToWireshark(src, dst, proto, length) {
  const time = (performance.now() / 1000).toFixed(4);
  const packetId = state.captureLog.length + 1;
  
  // Create rich hex payloads and collapsible trees
  const srcIP = src.ip || "192.168.1.10";
  const dstIP = dst.ip || "192.168.1.11";
  
  let infoText = "";
  if (proto === "TCP") {
    infoText = `8080 → 443 [SYN, ACK] Seq=1 Ack=1 Win=64240 Len=${length}`;
  } else if (proto === "UDP") {
    infoText = `Source Port: 53  Destination Port: 60124  Length: ${length}`;
  } else {
    infoText = `Echo (ping) request  id=0x03e8, seq=1, ttl=64`;
  }
  
  const packet = {
    id: packetId,
    time: time,
    src: srcIP,
    dst: dstIP,
    proto: proto,
    length: length,
    info: infoText,
    srcMac: src.mac || "00:00:00:00:00:00",
    dstMac: dst.mac || "00:00:00:00:00:00",
    srcPort: src.role === "host" ? 8080 : 80,
    dstPort: dst.role === "host" ? 443 : 53
  };
  
  state.captureLog.push(packet);
  
  // Render Wireshark Row
  const tbody = $("wsTableBody");
  const tr = document.createElement("tr");
  tr.id = `ws-row-${packetId}`;
  tr.addEventListener("click", () => selectWiresharkPacket(packetId));
  
  const protoClass = proto === "TCP" ? "ws-proto-tcp" : proto === "UDP" ? "ws-proto-udp" : "ws-proto-icmp";
  
  tr.innerHTML = `
    <td>${packetId}</td>
    <td>${time}</td>
    <td>${srcIP}</td>
    <td>${dstIP}</td>
    <td class="${protoClass}">${proto}</td>
    <td>${length}</td>
    <td>${packet.info}</td>
  `;
  
  tbody.appendChild(tr);
  
  // Keep logs at a reasonable length
  if (state.captureLog.length > 50) {
    state.captureLog.shift();
    if (tbody.children.length > 0) tbody.removeChild(tbody.firstChild);
  }
  
  // Auto scroll table
  const listContainer = document.querySelector(".ws-list-container");
  listContainer.scrollTop = listContainer.scrollHeight;
}

// Select a single packet to display parsed details
function selectWiresharkPacket(id) {
  state.selectedPacketId = id;
  
  // Highlight active row
  document.querySelectorAll("#wsTableBody tr").forEach(tr => tr.classList.remove("active-row"));
  const activeRow = $(`ws-row-${id}`);
  if (activeRow) activeRow.classList.add("active-row");
  
  const packet = state.captureLog.find(p => p.id === id);
  if (!packet) return;
  
  const container = $("wsDetailContent");
  container.innerHTML = "";
  
  // Frame 1 Details
  const nodeFrame = createTreeNode("Frame Details", [
    `Frame Number: ${packet.id}`,
    `Arrival Time: May 25, 2026 22:06:50`,
    `Epoch Time: ${packet.time} seconds`,
    `Frame Length: ${packet.length} bytes (${packet.length * 8} bits)`
  ]);
  
  // Ethernet II Details
  const nodeEth = createTreeNode("Ethernet II, Src: " + packet.srcMac + ", Dst: " + packet.dstMac, [
    `Destination: ${packet.dstMac}`,
    `Source: ${packet.srcMac}`,
    `Type: IPv4 (0x0800)`
  ]);
  
  // Internet Protocol Details
  const nodeIP = createTreeNode(`Internet Protocol Version 4, Src: ${packet.src}, Dst: ${packet.dst}`, [
    `Version: 4`,
    `Header Length: 20 bytes`,
    `Differentiated Services Field: 0x00`,
    `Total Length: ${packet.length}`,
    `Identification: 0xb52b (46379)`,
    `Flags: 0x4000, Don't fragment`,
    `Time to Live (TTL): 64`,
    `Protocol: ${packet.proto} (${packet.proto === 'TCP' ? 6 : packet.proto === 'UDP' ? 17 : 1})`,
    `Header Checksum: 0x2bb4 [verified]`,
    `Source Address: ${packet.src}`,
    `Destination Address: ${packet.dst}`
  ]);
  
  // Transport Layer Details
  let nodeTransport = null;
  if (packet.proto === "TCP") {
    nodeTransport = createTreeNode(`Transmission Control Protocol, Src Port: ${packet.srcPort}, Dst Port: ${packet.dstPort}, Seq: 1, Ack: 1`, [
      `Source Port: ${packet.srcPort}`,
      `Destination Port: ${packet.dstPort}`,
      `Sequence Number: 1 (relative sequence number)`,
      `Acknowledgment Number: 1 (relative ack number)`,
      `Header Length: 20 bytes`,
      `Flags: 0x012 (SYN, ACK)`,
      `Window: 64240`,
      `Checksum: 0xf31a [unverified]`,
      `Urgent Pointer: 0`
    ]);
  } else if (packet.proto === "UDP") {
    nodeTransport = createTreeNode(`User Datagram Protocol, Src Port: ${packet.srcPort}, Dst Port: ${packet.dstPort}`, [
      `Source Port: ${packet.srcPort}`,
      `Destination Port: ${packet.dstPort}`,
      `Length: ${packet.length - 20}`,
      `Checksum: 0x4fca [verified]`
    ]);
  } else {
    nodeTransport = createTreeNode(`Internet Control Message Protocol`, [
      `Type: 8 (Echo (ping) request)`,
      `Code: 0`,
      `Checksum: 0x471d [correct]`,
      `Identifier: 0x03e8`,
      `Sequence Number: 1`
    ]);
  }
  
  // Dummy hex payload block
  const nodePayload = createTreeNode(`Decoded Packet Payload data (${packet.length} bytes)`, [
    `0000   00 50 56 c0 00 08 00 0c  29 d4 e1 f2 08 00 45 00   .PV...)..)....E.`,
    `0010   00 28 b5 2b 40 00 40 06  2b b4 c0 a8 01 0a c0 a8   .(.+@.@.+.......`,
    `0020   01 1b 1f 90 00 50 00 00  00 01 00 00 00 01 50 10   .....P........P.`,
    `0030   fa f0 b3 0a 00 00                                  ......`
  ]);
  
  container.appendChild(nodeFrame);
  container.appendChild(nodeEth);
  container.appendChild(nodeIP);
  container.appendChild(nodeTransport);
  container.appendChild(nodePayload);
}

// Collapsible trees builder for Wireshark
function createTreeNode(title, items) {
  const node = document.createElement("div");
  node.className = "ws-tree-node";
  
  const titleDiv = document.createElement("div");
  titleDiv.className = "ws-tree-title";
  titleDiv.textContent = title;
  titleDiv.addEventListener("click", () => {
    node.classList.toggle("collapsed");
  });
  
  const childrenDiv = document.createElement("div");
  childrenDiv.className = "ws-tree-children";
  
  items.forEach((text) => {
    const item = document.createElement("div");
    item.className = "ws-tree-item";
    item.textContent = text;
    childrenDiv.appendChild(item);
  });
  
  node.appendChild(titleDiv);
  node.appendChild(childrenDiv);
  return node;
}

// Clear logs
function clearWiresharkCapture() {
  state.captureLog = [];
  $("wsTableBody").innerHTML = "";
  $("wsDetailContent").innerHTML = `<p class="placeholder-msg">Select a packet from the capture log to decode headers and payload data.</p>`;
}

// Clear analytics counters
function clearAnalytics() {
  state.stats.processed = 0;
  state.stats.drops = 0;
  state.stats.throughput = 0;
  
  state.nodes.broadcast.forEach(n => n.count = 0);
  state.nodes.unicast.forEach(n => n.count = 0);
  state.nodes.msgpassing.forEach(n => n.count = 0);
  
  updateAnalyticsUI();
  updateActiveNodeList();
}

// Poll stats from standard C backend if running
async function pollBackendStats() {
  try {
    const response = await fetch("/api/stats");
    const stats = await response.json();
    
    // Sync backend numbers if they are non-zero (i.e. if C backend generated them)
    if (stats.processed > 0) {
      state.stats.processed = stats.processed;
      state.stats.drops = stats.drops;
      state.stats.throughput = stats.throughput;
      state.stats.seqLatencyUs = stats.sequentialLatencyUs;
      state.stats.parLatencyUs = stats.parallelLatencyUs;
      
      updateAnalyticsUI();
    }
  } catch (e) {
    // Ignore server connection error - standalone simulation works flawlessly
  }
}
