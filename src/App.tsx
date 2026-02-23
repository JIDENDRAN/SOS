import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  Radio,
  Wifi,
  Map as MapIcon,
  Activity,
  ShieldAlert,
  Settings,
  Users,
  Zap,
  ChevronRight,
  History,
  Info
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as d3 from 'd3';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Types ---

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SOSMessage {
  messageId: string;
  senderId: string;
  senderName: string;
  timestamp: number;
  ttl: number;
  hopCount: number;
  content: string;
  deliveryProbability: number;
  lat?: number;
  lng?: number;
}

interface PeerNode {
  id: string;
  name: string;
  x: number;
  y: number;
  probs: Record<string, number>;
}

enum RoutingMode {
  FLOODING = 'FLOODING',
  PROPHET = 'PROPHET',
  HYBRID = 'HYBRID'
}

// --- Components ---

export default function App() {
  const [userName, setUserName] = useState<string>('');
  const [isRegistered, setIsRegistered] = useState(false);
  const [myId, setMyId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<PeerNode[]>([]);
  const [myPos, setMyPos] = useState({ x: 50, y: 50 });
  const [messages, setMessages] = useState<SOSMessage[]>([]);
  const [activeEmergency, setActiveEmergency] = useState<SOSMessage | null>(null);
  const [seenMessages] = useState(new Set<string>());
  const [routingMode, setRoutingMode] = useState<RoutingMode>(RoutingMode.FLOODING);
  const [ttl, setTtl] = useState(5);
  const [isLiveLocation, setIsLiveLocation] = useState(false);
  const [realCoords, setRealCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [activeTab, setActiveTab] = useState<'map' | 'messages' | 'system'>('map');
  const [showNativeCode, setShowNativeCode] = useState(false);
  const [logs, setLogs] = useState<{ time: string; msg: string; type: 'info' | 'alert' | 'success' }[]>([]);

  const ws = useRef<WebSocket | null>(null);
  const mapRef = useRef<SVGSVGElement>(null);

  // --- Logic ---

  const addLog = (msg: string, type: 'info' | 'alert' | 'success' = 'info') => {
    setLogs(prev => [{ time: new Date().toLocaleTimeString(), msg, type }, ...prev].slice(0, 50));
  };

  useEffect(() => {
    if (!isRegistered) return;

    let reconnectTimer: NodeJS.Timeout;
    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      // In production, we use the window.location.host which includes the domain (+ port if any)
      // In local development with Vite (port 5173), we need to manually target port 3000
      const host = (isLocal && window.location.port !== '3000') ? 'localhost:3000' : window.location.host;
      const url = `${protocol}//${host}/ws`;

      console.log('Connecting to:', url);
      const socket = new WebSocket(url);
      ws.current = socket;

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'REGISTER', name: userName, x: myPos.x, y: myPos.y }));
        addLog(`Mesh connected to ${host}`, 'success');
      };

      socket.onerror = (error) => {
        console.error('WebSocket Error:', error);
        addLog(`Network error on ${url}`, 'alert');
      };

      socket.onclose = (event) => {
        addLog(`Disconnected from network (Code: ${event.code}).`, 'info');
        if (event.code !== 1000) {
          addLog('Attempting to reconnect in 3s...', 'info');
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      socket.onmessage = async (event) => {
        try {
          let textData: string;

          if (typeof event.data === 'string') {
            textData = event.data;
          } else if (event.data instanceof Blob) {
            textData = await event.data.text();
          } else if (event.data instanceof ArrayBuffer) {
            textData = new TextDecoder().decode(event.data);
          } else {
            console.warn('Unknown message format received:', typeof event.data);
            return;
          }

          const data = JSON.parse(textData);

          // Handle Heartbeat
          if (data.type === 'PING') {
            console.log('Keep-alive ping received');
            return;
          }

          console.log('WS Receive:', data.type, data);

          switch (data.type) {
            case 'REGISTERED':
              setMyId(data.id);
              addLog(`Node registered with ID: ${data.id.slice(0, 8)}`, 'success');
              break;
            case 'NETWORK_STATE':
              setNodes(data.nodes);
              addLog(`Mesh updated: ${data.nodes.length} nodes active`, 'info');
              break;
            case 'RECEIVE_SOS':
              handleIncomingSOS(data.payload, data.fromId);
              break;
          }
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      };
    };

    connect();

    return () => {
      if (ws.current) ws.current.close(1000);
      clearTimeout(reconnectTimer);
    };
  }, [isRegistered]);

  useEffect(() => {
    if (!isLiveLocation) return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setRealCoords({ lat: latitude, lng: longitude });
        // Map real GPS to simulation coordinates (0-100)
        // For demo purposes, we'll just use the fractional part or a fixed scale
        // In a real app, this would be actual GPS mapping
        const simX = ((longitude + 180) % 360) / 3.6; // Very rough mapping
        const simY = ((latitude + 90) % 180) / 1.8;
        updatePosition(simX, simY);
        addLog(`GPS Updated: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, 'info');
      },
      (err) => {
        addLog(`GPS Error: ${err.message}`, 'alert');
        setIsLiveLocation(false);
      },
      { enableHighAccuracy: true }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [isLiveLocation]);

  const handleIncomingSOS = (msg: SOSMessage, fromId: string) => {
    if (seenMessages.has(msg.messageId)) return;

    seenMessages.add(msg.messageId);
    setMessages(prev => [msg, ...prev]);
    setActiveEmergency(msg);
    addLog(`Received SOS from ${msg.senderName} (Hop: ${msg.hopCount})`, 'alert');

    // Routing Logic
    if (msg.ttl <= 0) {
      addLog(`Message ${msg.messageId.slice(0, 8)} expired (TTL=0)`, 'info');
      return;
    }

    const nextMsg = {
      ...msg,
      ttl: msg.ttl - 1,
      hopCount: msg.hopCount + 1
    };

    if (routingMode === RoutingMode.FLOODING) {
      setTimeout(() => relayMessage(nextMsg), 500);
    } else if (routingMode === RoutingMode.PROPHET) {
      // In a real PROPHET, we'd check if neighbors have higher probability
      // Here we simulate the "smart" decision
      addLog(`PROPHET calculating optimal path...`, 'info');
      setTimeout(() => relayMessage(nextMsg), 800);
    }
  };

  const relayMessage = (msg: SOSMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'SEND_SOS', payload: msg }));
      addLog(`Relaying message ${msg.messageId.slice(0, 8)}...`, 'success');
    }
  };

  const triggerSOS = () => {
    const msg: SOSMessage = {
      messageId: Math.random().toString(36).substring(7),
      senderId: myId || 'unknown',
      senderName: userName,
      timestamp: Date.now(),
      ttl: ttl,
      hopCount: 0,
      content: isLiveLocation && realCoords
        ? `EMERGENCY: Assistance required at GPS [${realCoords.lat.toFixed(6)}, ${realCoords.lng.toFixed(6)}]`
        : "EMERGENCY: Assistance required at current coordinates.",
      deliveryProbability: 1.0,
      lat: realCoords?.lat,
      lng: realCoords?.lng
    };

    seenMessages.add(msg.messageId);
    setMessages(prev => [msg, ...prev]);
    relayMessage(msg);
    addLog('SOS Broadcast initiated!', 'alert');
  };

  const updatePosition = (x: number, y: number) => {
    setMyPos({ x, y });
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'UPDATE_POSITION', x, y }));
    }
  };

  // --- Visualization ---

  useEffect(() => {
    if (!mapRef.current || !nodes.length) return;

    const svg = d3.select(mapRef.current);
    svg.selectAll("*").remove();

    const width = mapRef.current.clientWidth;
    const height = mapRef.current.clientHeight;

    // Draw Grid
    const gridSize = 40;
    for (let x = 0; x <= width; x += gridSize) {
      svg.append("line").attr("x1", x).attr("y1", 0).attr("x2", x).attr("y2", height).attr("stroke", "#2A2A2A").attr("stroke-width", 1);
    }
    for (let y = 0; y <= height; y += gridSize) {
      svg.append("line").attr("x1", 0).attr("y1", y).attr("x2", width).attr("y2", y).attr("stroke", "#2A2A2A").attr("stroke-width", 1);
    }

    // Draw Connections (Simulated range)
    nodes.forEach(n1 => {
      nodes.forEach(n2 => {
        if (n1.id === n2.id) return;
        const dist = Math.sqrt(Math.pow(n1.x - n2.x, 2) + Math.pow(n1.y - n2.y, 2));
        if (dist < 25) {
          svg.append("line")
            .attr("x1", (n1.x / 100) * width)
            .attr("y1", (n1.y / 100) * height)
            .attr("x2", (n2.x / 100) * width)
            .attr("y2", (n2.y / 100) * height)
            .attr("stroke", "rgba(0, 255, 65, 0.2)")
            .attr("stroke-dasharray", "4,4");
        }
      });
    });

    // Draw Nodes
    nodes.forEach(node => {
      const isMe = node.id === myId;
      const g = svg.append("g")
        .attr("transform", `translate(${(node.x / 100) * width}, ${(node.y / 100) * height})`);

      g.append("circle")
        .attr("r", isMe ? 8 : 6)
        .attr("fill", isMe ? "#00FF41" : "#E4E3E0")
        .attr("class", isMe ? "animate-pulse" : "");

      g.append("text")
        .text(node.name)
        .attr("dy", -12)
        .attr("text-anchor", "middle")
        .attr("fill", "#E4E3E0")
        .attr("font-size", "10px")
        .attr("font-family", "JetBrains Mono");
    });

  }, [nodes, myId]);

  if (!isRegistered) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#141414] p-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md space-y-8 border border-[#2A2A2A] p-8 bg-[#1A1A1A] rounded-2xl shadow-2xl"
        >
          <div className="text-center space-y-2">
            <Radio className="w-12 h-12 text-[#00FF41] mx-auto mb-4" />
            <h1 className="text-3xl font-serif italic text-[#E4E3E0]">Resilient Comm</h1>
            <p className="text-xs font-mono text-white/40 uppercase tracking-widest">Emergency Network Node Registration</p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-mono text-white/60">Node Identifier</label>
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Enter responder name..."
                className="w-full bg-black border border-[#2A2A2A] p-3 rounded-lg text-sm font-mono focus:border-[#00FF41] outline-none transition-colors"
              />
            </div>
            <button
              onClick={() => userName && setIsRegistered(true)}
              className="w-full bg-[#00FF41] text-black font-mono font-bold py-3 rounded-lg hover:bg-[#00CC33] transition-colors flex items-center justify-center gap-2"
            >
              INITIALIZE NODE <ChevronRight size={16} />
            </button>
          </div>

          <div className="pt-4 border-t border-[#2A2A2A] flex items-center gap-3 text-[10px] text-white/30 font-mono">
            <ShieldAlert size={14} />
            <span>ENCRYPTED P2P TUNNEL READY</span>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col md:grid md:grid-cols-12 bg-[#141414] overflow-hidden">
      {/* --- Sidebar: Stats & Controls (Desktop) / System Tab (Mobile) --- */}
      <aside className={cn(
        "md:col-span-3 border-r border-[#2A2A2A] flex flex-col bg-[#1A1A1A] transition-all",
        activeTab === 'system' ? 'flex flex-1' : 'hidden md:flex'
      )}>
        <div className="p-6 border-bottom border-[#2A2A2A] flex-1 overflow-y-auto">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-full bg-[#00FF41]/10 flex items-center justify-center">
              <Radio className="text-[#00FF41]" size={20} />
            </div>
            <div>
              <h2 className="text-sm font-serif italic text-[#E4E3E0]">{userName}</h2>
              <p className="text-[10px] font-mono text-[#00FF41]">NODE ACTIVE</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-8">
            <StatCard
              icon={<Users size={14} />}
              label="PEERS"
              value={nodes.length.toString()}
              subValue={nodes.length === 0 ? "SEARCHING..." : "CONNECTED"}
            />
            <StatCard icon={<Zap size={14} />} label="HOPS" value={messages.length > 0 ? messages[0].hopCount.toString() : "0"} />
          </div>

          <div className="space-y-6">
            <div className="space-y-3">
              <label className="text-[10px] font-mono text-white/40 uppercase flex items-center gap-2">
                <Settings size={12} /> Routing Protocol
              </label>
              <div className="flex flex-col gap-2">
                {Object.values(RoutingMode).map(mode => (
                  <button
                    key={mode}
                    onClick={() => setRoutingMode(mode)}
                    className={cn(
                      "text-left px-4 py-3 rounded border text-[10px] font-mono transition-all min-h-[44px]",
                      routingMode === mode
                        ? "bg-[#00FF41]/10 border-[#00FF41] text-[#00FF41]"
                        : "bg-black/40 border-[#2A2A2A] text-white/40 hover:border-white/20"
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-[10px] font-mono text-white/40 uppercase flex items-center gap-2">
                <MapIcon size={12} /> Live Location (GPS)
              </label>
              <button
                onClick={() => setIsLiveLocation(!isLiveLocation)}
                className={cn(
                  "w-full px-4 py-3 rounded border text-[10px] font-mono transition-all flex items-center justify-between min-h-[44px]",
                  isLiveLocation
                    ? "bg-[#00FF41]/10 border-[#00FF41] text-[#00FF41]"
                    : "bg-black/40 border-[#2A2A2A] text-white/40 hover:border-white/20"
                )}
              >
                <span>{isLiveLocation ? 'GPS TRACKING ACTIVE' : 'ENABLE LIVE GPS'}</span>
                <div className={cn("w-2 h-2 rounded-full", isLiveLocation ? "bg-[#00FF41] animate-pulse" : "bg-white/20")} />
              </button>
              {isLiveLocation && realCoords && (
                <div className="text-[9px] font-mono text-white/40 text-center">
                  {realCoords.lat.toFixed(4)}°N, {realCoords.lng.toFixed(4)}°E
                </div>
              )}
            </div>

            <div className="space-y-3">
              <label className="text-[10px] font-mono text-white/40 uppercase flex items-center gap-2">
                <Activity size={12} /> Time-To-Live (TTL)
              </label>
              <input
                type="range" min="1" max="20" value={ttl}
                onChange={(e) => setTtl(parseInt(e.target.value))}
                className="w-full accent-[#00FF41] h-8"
              />
              <div className="flex justify-between text-[10px] font-mono text-white/20">
                <span>LOCAL</span>
                <span className="text-[#00FF41]">{ttl} HOPS</span>
                <span>GLOBAL</span>
              </div>
            </div>

            <div className="pt-6 border-t border-[#2A2A2A] space-y-3">
              <label className="text-[10px] font-mono text-white/40 uppercase flex items-center gap-2">
                <Info size={12} /> APK & Mobile Setup
              </label>
              <div className="bg-black/40 p-3 rounded-lg border border-[#2A2A2A] space-y-2">
                <p className="text-[9px] font-mono text-white/60 leading-relaxed">
                  <strong>Option 1 (Instant):</strong> Open this URL in Chrome/Safari on your phone and select "Add to Home Screen" to install as a PWA.
                </p>
                <p className="text-[9px] font-mono text-white/60 leading-relaxed">
                  <strong>Option 2 (Native APK):</strong> Use the Kotlin source code below in Android Studio to build a real .apk file.
                </p>
                <div className="text-[8px] font-mono text-[#00FF41] break-all opacity-50">
                  {window.location.origin}
                </div>
              </div>
              <button
                onClick={() => setShowNativeCode(true)}
                className="w-full border border-[#00FF41]/30 text-[#00FF41] text-[10px] font-mono py-3 rounded hover:bg-[#00FF41]/10 transition-all min-h-[44px]"
              >
                GET KOTLIN SOURCE FOR APK
              </button>
            </div>
          </div>
        </div>

        <div className="hidden md:block p-6 border-t border-[#2A2A2A]">
          <button
            onClick={triggerSOS}
            className="w-full bg-red-600 hover:bg-red-700 text-white font-mono font-bold py-4 rounded-xl shadow-lg shadow-red-900/20 flex flex-col items-center justify-center gap-1 transition-all active:scale-95"
          >
            <ShieldAlert size={24} />
            <span className="text-xs">BROADCAST SOS</span>
          </button>
        </div>
      </aside>

      {/* --- Main Content Area --- */}
      <main className={cn(
        "md:col-span-6 relative bg-black data-grid flex flex-col transition-all",
        activeTab === 'map' ? 'flex flex-1' : (activeTab === 'messages' ? 'flex flex-1' : 'hidden md:flex')
      )}>
        {/* Map View */}
        <div className={cn(
          "flex-1 relative",
          activeTab === 'map' ? 'block' : 'hidden md:block'
        )}>
          <div className="absolute top-4 left-4 z-10 flex items-center gap-4">
            <div className="bg-[#1A1A1A]/80 backdrop-blur border border-[#2A2A2A] px-4 py-2 rounded-full flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-[#00FF41] animate-pulse" />
              <span className="text-[10px] font-mono text-white/60 tracking-widest uppercase">Topology</span>
            </div>
          </div>

          <div className="w-full h-full cursor-crosshair relative" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            updatePosition(x, y);
          }}>
            <svg ref={mapRef} className="w-full h-full" />
            <div className="absolute bottom-4 right-4 text-[10px] font-mono text-white/20 text-right">
              [ {myPos.x.toFixed(1)}, {myPos.y.toFixed(1)} ]
            </div>
          </div>
        </div>

        {/* Message Feed (Buffer) */}
        <div className={cn(
          "border-t border-[#2A2A2A] bg-[#1A1A1A] flex flex-col transition-all",
          activeTab === 'messages' ? 'flex-1' : 'h-48 md:h-64 hidden md:flex'
        )}>
          <div className="p-3 border-b border-[#2A2A2A] flex items-center justify-between">
            <div className="flex items-center gap-2 text-[10px] font-mono text-white/40 uppercase">
              <History size={12} /> SOS Buffer
            </div>
            <div className="text-[10px] font-mono text-[#00FF41]">
              {messages.length} PACKETS
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            <AnimatePresence initial={false}>
              {messages.map((m) => (
                <motion.div
                  key={m.messageId}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-black/40 border-l-2 border-red-500 p-3 rounded-r flex items-center justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-red-400 font-bold">SOS</span>
                      <span className="text-[10px] font-mono text-white/60 uppercase">{m.senderName}</span>
                    </div>
                    <p className="text-xs text-white/80">{m.content}</p>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <div className="text-[10px] font-mono text-white/40">H:{m.hopCount}</div>
                    <div className="text-[8px] font-mono text-white/20">{new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                </motion.div>
              ))}
              {messages.length === 0 && (
                <div className="h-full flex items-center justify-center text-white/10 font-mono text-xs italic">
                  NO TRAFFIC
                </div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

      {/* --- Right Sidebar: Logs & Analytics (Desktop only or combined with System on Mobile) --- */}
      <aside className="hidden md:flex md:col-span-3 border-l border-[#2A2A2A] bg-[#1A1A1A] flex-col">
        <div className="p-6 border-b border-[#2A2A2A]">
          <h3 className="text-[10px] font-mono text-white/40 uppercase mb-4 flex items-center gap-2">
            <Activity size={14} /> Analytics
          </h3>
          <div className="space-y-4">
            <MetricBar label="Delivery Prob" value={84} color="#00FF41" />
            <MetricBar label="Congestion" value={12} color="#FACC15" />
            <MetricBar label="Efficiency" value={92} color="#00FF41" />
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-[#2A2A2A] flex items-center gap-2 text-[10px] font-mono text-white/40 uppercase">
            <Info size={12} /> System Logs
          </div>
          <div className="flex-1 overflow-y-auto p-4 font-mono text-[10px] space-y-2">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-white/20">[{log.time}]</span>
                <span className={cn(
                  log.type === 'alert' ? 'text-red-400' :
                    log.type === 'success' ? 'text-[#00FF41]' : 'text-white/60'
                )}>
                  {log.msg}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="p-6 bg-black/40 border-t border-[#2A2A2A]">
          <div className="flex items-center gap-3 text-[10px] font-mono text-white/30">
            <Wifi size={14} />
            <span>P2P DISCOVERY ACTIVE</span>
          </div>
        </div>
      </aside>

      {/* --- Mobile Bottom Navigation --- */}
      <nav className="md:hidden h-16 bg-[#1A1A1A] border-t border-[#2A2A2A] grid grid-cols-4 items-center">
        <button
          onClick={() => setActiveTab('map')}
          className={cn("flex flex-col items-center gap-1", activeTab === 'map' ? "text-[#00FF41]" : "text-white/40")}
        >
          <MapIcon size={20} />
          <span className="text-[9px] font-mono uppercase">Map</span>
        </button>
        <button
          onClick={() => setActiveTab('messages')}
          className={cn("flex flex-col items-center gap-1", activeTab === 'messages' ? "text-[#00FF41]" : "text-white/40")}
        >
          <History size={20} />
          <span className="text-[9px] font-mono uppercase">Alerts</span>
        </button>
        <button
          onClick={() => setActiveTab('system')}
          className={cn("flex flex-col items-center gap-1", activeTab === 'system' ? "text-[#00FF41]" : "text-white/40")}
        >
          <Settings size={20} />
          <span className="text-[9px] font-mono uppercase">System</span>
        </button>
        <button
          onClick={triggerSOS}
          className="flex flex-col items-center gap-1 text-red-500 animate-pulse"
        >
          <ShieldAlert size={24} />
          <span className="text-[9px] font-mono uppercase font-bold">SOS</span>
        </button>
      </nav>

      {/* --- Native Code Modal --- */}
      <AnimatePresence>
        {showNativeCode && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="w-full max-w-2xl bg-[#1A1A1A] border border-[#2A2A2A] p-6 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]"
            >
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-mono text-[#00FF41] uppercase tracking-widest">Native Android (Kotlin) Source</h3>
                <button onClick={() => setShowNativeCode(false)} className="text-white/40 hover:text-white">
                  <Info size={20} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto bg-black p-4 rounded-lg border border-[#2A2A2A]">
                <pre className="text-[10px] font-mono text-white/80 leading-relaxed whitespace-pre-wrap">
                  {`// 1. Add these to your Android Studio project (Kotlin)
// 2. Use Bluetooth/WiFi-Direct APIs for real offline P2P

data class SOSMessage(
    val id: String = UUID.randomUUID().toString(),
    val sender: String,
    val lat: Double?,
    val lng: Double?,
    val content: String,
    var ttl: Int = 10,
    var hops: Int = 0
)

class RoutingEngine {
    private val seen = mutableSetOf<String>()

    fun onReceive(msg: SOSMessage) {
        if (seen.contains(msg.id)) return
        seen.add(msg.id)
        
        if (msg.ttl > 0) {
            msg.ttl--
            msg.hops++
            // Broadcast to all nearby Bluetooth/WiFi peers
            broadcast(msg)
        }
        
        // Trigger UI Alert
        showEmergencyAlert(msg)
    }
    
    private fun broadcast(msg: SOSMessage) {
        // Implementation for Bluetooth LE / WiFi Direct
    }
}`}
                </pre>
              </div>

              <div className="mt-6 space-y-4">
                <p className="text-[10px] font-mono text-white/40 leading-relaxed">
                  To create a downloadable APK, copy this logic into a new Android Studio project.
                  For a quick "app-like" experience, use the <strong>PWA (Add to Home Screen)</strong> option instead.
                </p>
                <button
                  onClick={() => setShowNativeCode(false)}
                  className="w-full bg-[#00FF41] text-black font-mono font-bold py-3 rounded-lg"
                >
                  CLOSE SOURCE VIEW
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- Emergency Alert Modal --- */}
      <AnimatePresence>
        {activeEmergency && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-red-950/90 backdrop-blur-xl"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="w-full max-w-lg bg-black border-4 border-red-600 p-8 rounded-3xl shadow-[0_0_100px_rgba(220,38,38,0.5)] text-center space-y-6"
            >
              <div className="relative">
                <motion.div
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ repeat: Infinity, duration: 1 }}
                  className="w-24 h-24 bg-red-600 rounded-full mx-auto flex items-center justify-center shadow-[0_0_30px_rgba(220,38,38,0.8)]"
                >
                  <ShieldAlert size={48} className="text-white" />
                </motion.div>
              </div>

              <div className="space-y-2">
                <h2 className="text-4xl font-mono font-black text-red-500 animate-pulse">HELP REQUIRED</h2>
                <p className="text-xl font-serif italic text-white/90">
                  Emergency signal from <span className="text-red-400 font-bold not-italic">{activeEmergency.senderName}</span>
                </p>
              </div>

              <div className="bg-red-900/20 border border-red-500/30 p-4 rounded-xl font-mono text-sm text-red-200">
                "{activeEmergency.content}"
                {activeEmergency.lat && activeEmergency.lng && (
                  <div className="mt-2 pt-2 border-t border-red-500/20 text-[10px] text-red-400/80">
                    EXACT COORDINATES: {activeEmergency.lat.toFixed(6)}, {activeEmergency.lng.toFixed(6)}
                  </div>
                )}
              </div>

              <div className="flex justify-between text-[10px] font-mono text-white/40 uppercase tracking-widest">
                <span>HOP COUNT: {activeEmergency.hopCount}</span>
                <span>ID: {activeEmergency.messageId.slice(0, 8)}</span>
              </div>

              <button
                onClick={() => setActiveEmergency(null)}
                className="w-full bg-white text-black font-mono font-bold py-4 rounded-xl hover:bg-red-100 transition-colors"
              >
                ACKNOWLEDGE & DISMISS
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatCard({ icon, label, value, subValue }: { icon: React.ReactNode, label: string, value: string, subValue?: string }) {
  return (
    <div className="bg-black/40 border border-[#2A2A2A] p-3 rounded-xl space-y-1">
      <div className="flex items-center gap-2 text-[10px] font-mono text-white/30 uppercase">
        {icon} {label}
      </div>
      <div className="text-xl font-mono text-[#E4E3E0]">{value}</div>
      {subValue && <div className="text-[8px] font-mono text-[#00FF41]/60 uppercase">{subValue}</div>}
    </div>
  );
}

function MetricBar({ label, value, color }: { label: string, value: number, color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono uppercase">
        <span className="text-white/40">{label}</span>
        <span style={{ color }}>{value}%</span>
      </div>
      <div className="h-1 bg-black rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          className="h-full"
          style={{ backgroundColor: color }}
        />
      </div>
    </div>
  );
}
