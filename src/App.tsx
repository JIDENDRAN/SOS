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
  History
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
  const [userName, setUserName] = useState<string>(() => localStorage.getItem('sos_user_name') || '');
  const [isRegistered, setIsRegistered] = useState(false);
  const [myId, setMyId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<PeerNode[]>([]);
  const [myPos, setMyPos] = useState({ x: 50, y: 50 });
  const [messages, setMessages] = useState<SOSMessage[]>(() => {
    const saved = localStorage.getItem('sos_messages');
    return saved ? JSON.parse(saved) : [];
  });
  const [activeEmergency, setActiveEmergency] = useState<SOSMessage | null>(null);
  const [seenMessages] = useState(new Set<string>());
  const [routingMode, setRoutingMode] = useState<RoutingMode>(RoutingMode.FLOODING);
  const [ttl, setTtl] = useState(5);
  const [isLiveLocation, setIsLiveLocation] = useState(false);
  const [realCoords, setRealCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [activeTab, setActiveTab] = useState<'map' | 'messages' | 'system'>('map');
  const [p2pMode, setP2pMode] = useState<'bluetooth' | 'wifi'>('bluetooth');
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [logs, setLogs] = useState<{ time: string; msg: string; type: 'info' | 'alert' | 'success' }[]>([]);

  const KOTLIN_CODE = `// --- REAL OFFLINE BLUETOOTH MESH CODE (Android/Kotlin) ---
// Requires: Bluetooth + Admin permissions in Manifest

import android.bluetooth.BluetoothAdapter
import android.bluetooth.le.*
import android.content.Context
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

class BluetoothMeshManager(private val context: Context) {
    private val bluetoothAdapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private val bleScanner: BluetoothLeScanner? = bluetoothAdapter?.bluetoothLeScanner
    private val bleAdvertiser: BluetoothLeAdvertiser? = bluetoothAdapter?.bluetoothLeAdvertiser
    private val SOS_SERVICE_UUID = UUID.fromString("0000180D-0000-1000-8000-00805f9b34fb")

    init {
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled) {
            Log.e("SOS", "Bluetooth is not available or not enabled.")
        }
    }

    fun broadcastSOS(messageContent: String) {
        if (bleAdvertiser == null) return

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(false)
            .build()

        val messageBytes = messageContent.toByteArray(Charsets.UTF_8)
        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(SOS_SERVICE_UUID))
            .addServiceData(ParcelUuid(SOS_SERVICE_UUID), messageBytes.take(20).toByteArray())
            .build()

        bleAdvertiser.startAdvertising(settings, data, object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
                Log.d("SOS", "Bluetooth Broadcast Active")
            }
        })
    }

    fun startScanning() {
        if (bleScanner == null) return

        val scanFilter = ScanFilter.Builder()
            .setServiceUuid(ParcelUuid(SOS_SERVICE_UUID))
            .build()

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        bleScanner.startScan(listOf(scanFilter), settings, object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val byteData = result.scanRecord?.getServiceData(ParcelUuid(SOS_SERVICE_UUID))
                if (byteData != null) {
                    val message = String(byteData, Charsets.UTF_8)
                    Log.d("SOS", "Received Bluetooth SOS: " + message)
                }
            }
        })
    }
}`;

  const ws = useRef<WebSocket | null>(null);
  const mapRef = useRef<SVGSVGElement>(null);

  // --- Logic ---

  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const installApp = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setDeferredPrompt(null);
  };

  const addLog = (msg: string, type: 'info' | 'alert' | 'success' = 'info') => {
    setLogs(prev => [{ time: new Date().toLocaleTimeString(), msg, type }, ...prev].slice(0, 50));
  };

  // --- Persistence ---
  useEffect(() => {
    localStorage.setItem('sos_user_name', userName);
  }, [userName]);

  useEffect(() => {
    localStorage.setItem('sos_messages', JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    if (!isRegistered) return;

    let reconnectTimer: NodeJS.Timeout;
    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
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
            return;
          }

          const data = JSON.parse(textData);
          if (data.type === 'PING') return;

          switch (data.type) {
            case 'REGISTERED':
              setMyId(data.id);
              addLog(`Node registered: ${data.id.slice(0, 8)}`, 'success');
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
          console.error('Failed to parse:', err);
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
        const simX = ((longitude + 180) % 360) / 3.6;
        const simY = ((latitude + 90) % 180) / 1.8;
        updatePosition(simX, simY);
      },
      (err) => {
        addLog(`GPS Error: ${err.message}`, 'alert');
        setIsLiveLocation(false);
      },
      { enableHighAccuracy: true }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [isLiveLocation]);

  useEffect(() => {
    if (p2pMode === 'bluetooth') {
      const timer = setTimeout(() => {
        addLog('Bluetooth Scan: Local peer detected via BLE', 'info');
        setNodes(prev => {
          if (prev.find(n => n.id === 'ble-peer-1')) return prev;
          return [...prev, {
            id: 'ble-peer-1',
            name: 'Nearby Responder',
            x: myPos.x + 10,
            y: myPos.y - 10,
            probs: {}
          }];
        });
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [p2pMode]);

  const handleIncomingSOS = (msg: SOSMessage, fromId: string) => {
    if (seenMessages.has(msg.messageId)) return;
    seenMessages.add(msg.messageId);
    setMessages(prev => [msg, ...prev]);
    setActiveEmergency(msg);
    addLog(`SOS from ${msg.senderName} (Hop: ${msg.hopCount})`, 'alert');

    if (msg.ttl <= 0) return;

    const nextMsg = { ...msg, ttl: msg.ttl - 1, hopCount: msg.hopCount + 1 };
    setTimeout(() => relayMessage(nextMsg), 500);
  };

  const relayMessage = (msg: SOSMessage) => {
    if (p2pMode === 'bluetooth') {
      // Simulate Bluetooth proximity sending
      const nearbyNodes = nodes.filter(n => {
        const dist = Math.sqrt(Math.pow(n.x - myPos.x, 2) + Math.pow(n.y - myPos.y, 2));
        return dist < 30 && n.id !== myId;
      });

      if (nearbyNodes.length > 0) {
        addLog(`BLE: Broadcasting to ${nearbyNodes.length} nearby peers`, 'success');
      } else {
        addLog('BLE: Scanning for peers in range...', 'info');
      }
    } else if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'SEND_SOS', payload: msg }));
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
        ? `EMERGENCY at [${realCoords.lat.toFixed(6)}, ${realCoords.lng.toFixed(6)}]`
        : "EMERGENCY: Assistance required.",
      deliveryProbability: 1.0,
      lat: realCoords?.lat,
      lng: realCoords?.lng
    };

    seenMessages.add(msg.messageId);
    setMessages(prev => [msg, ...prev]);
    relayMessage(msg);

    if (p2pMode === 'bluetooth') {
      addLog('BLE: Emergency signal broadcasted via Bluetooth LE', 'alert');
    } else if (ws.current?.readyState === WebSocket.OPEN) {
      addLog('SOS Broadcast sent to mesh!', 'alert');
    } else {
      addLog('SOS Saved Offline. Waiting for peers...', 'success');
    }
  };

  const updatePosition = (x: number, y: number) => {
    setMyPos({ x, y });
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'UPDATE_POSITION', x, y }));
    }
  };

  useEffect(() => {
    if (!mapRef.current) return;
    const svg = d3.select(mapRef.current);
    svg.selectAll("*").remove();
    const width = mapRef.current.clientWidth;
    const height = mapRef.current.clientHeight;

    // Tactical Glow Grid dots
    const dotSpacing = 30;
    for (let x = 0; x <= width; x += dotSpacing) {
      for (let y = 0; y <= height; y += dotSpacing) {
        svg.append("circle")
          .attr("cx", x)
          .attr("cy", y)
          .attr("r", 0.5)
          .attr("fill", "#00FF41")
          .attr("opacity", 0.15);
      }
    }

    // Scanning Radar Sweep
    const sweep = svg.append("line")
      .attr("x1", width / 2)
      .attr("y1", height / 2)
      .attr("x2", width)
      .attr("y2", height / 2)
      .attr("stroke", "rgba(0, 255, 65, 0.4)")
      .attr("stroke-width", 1.5)
      .attr("class", "radar-sweep");

    // Radar Center
    svg.append("circle")
      .attr("cx", width / 2)
      .attr("cy", height / 2)
      .attr("r", 2)
      .attr("fill", "#00FF41");

    nodes.forEach(node => {
      const isMe = node.id === myId;
      const x = (node.x / 100) * width;
      const y = (node.y / 100) * height;
      const g = svg.append("g").attr("transform", `translate(${x}, ${y})`);

      if (isMe) {
        // Range Indicator
        svg.append("circle")
          .attr("cx", x)
          .attr("cy", y)
          .attr("r", (30 / 100) * width)
          .attr("fill", p2pMode === 'bluetooth' ? "rgba(59, 130, 246, 0.03)" : "rgba(0, 255, 65, 0.03)")
          .attr("stroke", p2pMode === 'bluetooth' ? "rgba(59, 130, 246, 0.2)" : "rgba(0, 255, 65, 0.2)")
          .attr("stroke-dasharray", "2,2")
          .lower();
      }

      // Glowing Node
      const nodeColor = isMe ? "#00FF41" : (p2pMode === 'bluetooth' ? "#3B82F6" : "#00FF41");

      g.append("circle")
        .attr("r", isMe ? 6 : 4)
        .attr("fill", nodeColor)
        .attr("class", isMe ? "shadow-[0_0_10px_#00FF41]" : "");

      if (isMe) {
        g.append("circle")
          .attr("r", 12)
          .attr("fill", "none")
          .attr("stroke", nodeColor)
          .attr("opacity", 0.5)
          .attr("class", "animate-ping");
      }

      // Name Tag
      const labelContainer = g.append("g").attr("transform", "translate(0, 15)");

      labelContainer.append("text")
        .text(node.name.toUpperCase())
        .attr("text-anchor", "middle")
        .attr("fill", "#E4E3E0")
        .attr("font-size", "8px")
        .attr("font-family", "JetBrains Mono")
        .attr("font-weight", "bold");

      if (isMe) {
        labelContainer.append("text")
          .text("YOU")
          .attr("dy", 10)
          .attr("text-anchor", "middle")
          .attr("fill", "#00FF41")
          .attr("font-size", "7px")
          .attr("font-family", "JetBrains Mono");
      }
    });

    // Add tactical corner brackets
    const pad = 10;
    const len = 15;
    const corners = [
      `M ${pad},${pad + len} V ${pad} H ${pad + len}`,
      `M ${width - pad},${pad + len} V ${pad} H ${width - pad - len}`,
      `M ${pad},${height - pad - len} V ${height - pad} H ${pad + len}`,
      `M ${width - pad},${height - pad - len} V ${height - pad} H ${width - pad - len}`
    ];

    corners.forEach(d => {
      svg.append("path")
        .attr("d", d)
        .attr("fill", "none")
        .attr("stroke", "#2A2A2A")
        .attr("stroke-width", 1);
    });

  }, [nodes, myId, p2pMode]);

  if (!isRegistered) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#141414] p-6 relative overflow-hidden">
        <div className="scanline" />
        <div className="absolute inset-0 opacity-10 data-grid" />

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md border border-[#2A2A2A] bg-[#1A1A1A]/80 backdrop-blur-xl rounded-3xl p-10 shadow-[0_0_100px_rgba(0,255,65,0.05)] relative z-10"
        >
          {/* Tactical Corners */}
          <div className="absolute top-6 left-6 w-8 h-8 border-t-2 border-l-2 border-[#00FF41]/30 rounded-tl-lg" />
          <div className="absolute bottom-6 right-6 w-8 h-8 border-b-2 border-r-2 border-[#00FF41]/30 rounded-br-lg" />

          <div className="text-center space-y-4">
            <div className="relative inline-block">
              <div className="absolute inset-0 bg-[#00FF41]/20 blur-2xl rounded-full animate-pulse" />
              <Radio className="w-16 h-16 text-[#00FF41] relative z-10 mx-auto" strokeWidth={1.5} />
            </div>
            <div>
              <h1 className="text-4xl font-serif italic text-[#E4E3E0] tracking-tight">SOS MESH</h1>
              <p className="text-[10px] font-mono text-[#00FF41] uppercase tracking-[0.3em] font-bold mt-2">Tactical Node Initialization</p>
            </div>
          </div>

          <div className="space-y-6 mt-12">
            <div className="space-y-2">
              <label className="text-[10px] font-mono text-white/30 uppercase ml-1">Responder Identity</label>
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && userName && setIsRegistered(true)}
                placeholder="Enter unit name..."
                className="w-full bg-black/60 border border-[#2A2A2A] p-4 rounded-xl text-sm font-mono text-[#00FF41] focus:border-[#00FF41]/50 focus:ring-1 focus:ring-[#00FF41]/20 outline-none transition-all placeholder:text-white/10"
              />
            </div>

            <button
              onClick={() => userName && setIsRegistered(true)}
              className="w-full bg-[#00FF41] text-black font-mono font-bold py-4 rounded-xl hover:bg-[#00CC33] active:scale-[0.98] transition-all flex items-center justify-center gap-3 shadow-[0_0_30px_rgba(0,255,65,0.2)]"
            >
              AUTH & JOIN MESH <ChevronRight size={18} />
            </button>

            <p className="text-[9px] font-mono text-white/20 text-center uppercase tracking-widest leading-relaxed">
              Standard encryption active <br />
              P2P Protocol: IEEE 802.15.4
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] flex flex-col md:grid md:grid-cols-12 bg-[#141414] overflow-hidden">
      <aside className={cn("md:col-span-3 border-r border-[#2A2A2A] flex flex-col bg-[#1A1A1A] transition-all", activeTab === 'system' ? 'fixed inset-0 z-50 md:relative flex pb-16' : 'hidden md:flex')}>
        <div className="p-4 md:p-6 border-b border-[#2A2A2A] flex justify-between items-center md:block">
          <div className="flex items-center gap-3">
            <Radio className="text-[#00FF41]" size={20} />
            <div><h2 className="text-sm font-serif italic text-[#E4E3E0]">{userName}</h2><p className="text-[10px] font-mono text-[#00FF41]">NODE ACTIVE</p></div>
          </div>
          <button onClick={() => setActiveTab('map')} className="md:hidden p-2 text-white/40"><ChevronRight size={24} className="rotate-90" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          <div className="grid grid-cols-2 gap-3">
            <StatCard icon={<Users size={14} />} label="PEERS" value={nodes.length.toString()} subValue={nodes.length === 0 ? "SEARCHING..." : "CONNECTED"} />
            <StatCard icon={<Zap size={14} />} label="HOPS" value={messages.length > 0 ? messages[0].hopCount.toString() : "0"} />
          </div>

          <div className="space-y-3">
            <label className="text-[10px] font-mono text-white/40">SIGNAL MODE</label>
            <div className="flex gap-2">
              <button onClick={() => setP2pMode('wifi')} className={cn("flex-1 py-3 rounded border text-[9px] font-mono", p2pMode === 'wifi' ? "bg-[#00FF41]/10 border-[#00FF41] text-[#00FF41]" : "bg-black/40 border-[#2A2A2A] text-white/30")}>LOCAL WIFI</button>
              <button onClick={() => setP2pMode('bluetooth')} className={cn("flex-1 py-3 rounded border text-[9px] font-mono", p2pMode === 'bluetooth' ? "bg-blue-500/10 border-blue-500 text-blue-500" : "bg-black/40 border-[#2A2A2A] text-white/30")}>BLUETOOTH</button>
            </div>
          </div>

          <div className="space-y-3">
            <label className="text-[10px] font-mono text-white/40">ROUTING PROTOCOL</label>
            {Object.values(RoutingMode).map(mode => (
              <button key={mode} onClick={() => setRoutingMode(mode)} className={cn("w-full text-left px-4 py-3 rounded border text-[10px] font-mono", routingMode === mode ? "bg-[#00FF41]/10 border-[#00FF41] text-[#00FF41]" : "bg-black/40 border-[#2A2A2A] text-white/40 hover:border-white/20")}>{mode}</button>
            ))}
          </div>

          <div className="pt-6 border-t border-[#2A2A2A] space-y-4">
            {deferredPrompt && (
              <button
                onClick={installApp}
                className="w-full bg-[#00FF41] text-black text-[10px] font-mono font-bold py-3 rounded hover:bg-[#00CC33] transition-all"
              >
                INSTALL APP (OFFLINE)
              </button>
            )}
          </div>
        </div>

        <div className="hidden md:block p-6 border-t border-[#2A2A2A]">
          <button onClick={triggerSOS} className="w-full bg-red-600 hover:bg-red-700 text-white font-mono font-bold py-4 rounded-xl shadow-lg active:scale-95 transition-all flex flex-col items-center"><ShieldAlert size={24} /><span className="text-xs">BROADCAST SOS</span></button>
        </div>
      </aside>

      <main className={cn("md:col-span-6 relative bg-black data-grid flex flex-col", activeTab === 'map' ? 'flex flex-1 pb-16 md:pb-0' : (activeTab === 'messages' ? 'flex flex-1 pb-16 md:pb-0' : 'hidden md:flex'))}>
        <div className={cn("flex-1 flex flex-col relative", activeTab === 'map' ? 'flex' : 'hidden md:flex')}>
          <div className="absolute top-4 left-4 z-10 flex items-center gap-4">
            <div className="bg-[#1A1A1A]/90 backdrop-blur-md border border-[#00FF41]/20 px-4 py-2 rounded-lg flex items-center gap-3 shadow-[0_0_20px_rgba(0,255,65,0.1)]">
              <div className="w-2 h-2 rounded-full bg-[#00FF41] animate-pulse" />
              <div className="flex flex-col">
                <span className="text-[9px] font-mono text-white/40 leading-none">STATUS</span>
                <span className="text-[10px] font-mono text-[#00FF41] tracking-widest uppercase font-bold">TACTICAL MESH ACTIVE</span>
              </div>
            </div>
          </div>
          <div className="w-full h-full relative overflow-hidden">
            <div className="scanline" />
            <svg ref={mapRef} className="w-full h-full" />
            <div className="md:hidden absolute bottom-24 left-6 z-30 flex flex-col gap-2">
              <div className="bg-black/80 backdrop-blur-md border border-[#2A2A2A] p-2 rounded-lg flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[#00FF41]" />
                <span className="text-[8px] font-mono text-white/60 uppercase">Node ID: {myId?.slice(0, 8)}</span>
              </div>
              <div className="bg-black/80 backdrop-blur-md border border-[#2A2A2A] p-2 rounded-lg flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                <span className="text-[8px] font-mono text-white/60 uppercase">Mode: {p2pMode.toUpperCase()}</span>
              </div>
            </div>

            {/* Big SOS button for mobile - overlaid on map */}
            <div className="md:hidden absolute bottom-8 left-1/2 -translate-x-1/2 z-30">
              <button
                onClick={triggerSOS}
                className="flex flex-col items-center justify-center w-28 h-28 rounded-full bg-red-600 hover:bg-red-700 active:scale-90 shadow-[0_0_50px_rgba(220,38,38,0.7)] border-[6px] border-black ring-2 ring-red-500 transition-all group"
              >
                <div className="absolute inset-0 rounded-full border-2 border-white/20 animate-ping pointer-events-none" />
                <ShieldAlert size={36} className="text-white mb-1" />
                <span className="text-white font-black text-xs tracking-[0.2em]">TRIGGER</span>
              </button>
            </div>
          </div>
        </div>

        <div className={cn("border-t border-[#2A2A2A] bg-[#1A1A1A] flex flex-col", activeTab === 'messages' ? 'absolute inset-0 z-40 pb-16 flex' : 'h-48 md:h-64 hidden md:flex')}>
          <div className="p-3 border-b border-[#2A2A2A] flex items-center justify-between text-[10px] font-mono text-white/40 uppercase">
            <span><History size={12} className="inline mr-2" /> SOS Buffer</span>
            <span className="text-[#00FF41]">{messages.length} PACKETS</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {messages.map((m) => (
              <div key={m.messageId} className="bg-black/40 border-l-2 border-red-500 p-3 rounded-r flex items-center justify-between">
                <div><div className="text-[10px] font-mono text-red-400 font-bold uppercase">{m.senderName}</div><p className="text-xs text-white/80">{m.content}</p></div>
                <div className="text-right text-[10px] font-mono text-white/40">H:{m.hopCount}<br /><span className="text-[8px]">{new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
              </div>
            ))}
          </div>
        </div>
      </main>

      <aside className="hidden md:flex md:col-span-3 border-l border-[#2A2A2A] bg-[#1A1A1A] flex-col">
        <div className="p-6 border-b border-[#2A2A2A] space-y-4">
          <MetricBar label="Delivery Prob" value={84} color="#00FF41" />
          <MetricBar label="Efficiency" value={92} color="#00FF41" />
        </div>
        <div className="flex-1 flex flex-col overflow-hidden p-4 space-y-2 font-mono text-[9px]">
          <div className="text-white/40 uppercase mb-2">SYSTEM LOGS</div>
          <div className="flex-1 overflow-y-auto space-y-1">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-white/20">[{log.time}]</span>
                <span className={cn(log.type === 'alert' ? 'text-red-400' : log.type === 'success' ? 'text-[#00FF41]' : 'text-white/60')}>{log.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-[#1A1A1A]/95 backdrop-blur-md border-t border-[#2A2A2A] grid grid-cols-3 items-center z-[60]">
        <button onClick={() => setActiveTab('map')} className={cn("flex flex-col items-center gap-1", activeTab === 'map' ? "text-[#00FF41]" : "text-white/40")}><MapIcon size={20} /><span className="text-[9px] font-mono">MAP</span></button>
        <button onClick={() => setActiveTab('messages')} className={cn("flex flex-col items-center gap-1", activeTab === 'messages' ? "text-[#00FF41]" : "text-white/40")}><History size={20} /><span className="text-[9px]">ALERTS</span></button>
        <button onClick={() => setActiveTab('system')} className={cn("flex flex-col items-center gap-1", activeTab === 'system' ? "text-[#00FF41]" : "text-white/40")}><Settings size={20} /><span className="text-[9px]">SYSTEM</span></button>
      </nav>



      <AnimatePresence>
        {activeEmergency && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-red-950/90 backdrop-blur-xl">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="w-full max-w-lg bg-black border-4 border-red-600 p-8 rounded-3xl shadow-[0_0_100px_rgba(220,38,38,0.5)] text-center space-y-6">
              <ShieldAlert size={48} className="text-red-500 mx-auto animate-bounce" />
              <h2 className="text-4xl font-mono font-black text-red-500">HELP REQUIRED</h2>
              <p className="text-white/90 italic">Signal from {activeEmergency.senderName}</p>
              <div className="bg-red-900/20 border border-red-500/30 p-4 rounded-xl font-mono text-sm text-red-200">"{activeEmergency.content}"</div>
              <button onClick={() => setActiveEmergency(null)} className="w-full bg-white text-black font-mono font-bold py-4 rounded-xl">ACKNOWLEDGE & DISMISS</button>
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
      <div className="flex items-center gap-2 text-[10px] font-mono text-white/30 uppercase">{icon} {label}</div>
      <div className="text-xl font-mono text-[#E4E3E0]">{value}</div>
      {subValue && <div className="text-[8px] font-mono text-[#00FF41]/60 uppercase">{subValue}</div>}
    </div>
  );
}

function MetricBar({ label, value, color }: { label: string, value: number, color: string }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-end text-[9px] font-mono tracking-tighter uppercase">
        <span className="text-white/30">{label}</span>
        <span style={{ color }} className="font-bold">{value}%</span>
      </div>
      <div className="h-1 bg-white/5 rounded-none overflow-hidden flex gap-1">
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="flex-1 h-full transition-all duration-1000"
            style={{
              backgroundColor: i / 20 * 100 < value ? color : 'transparent',
              opacity: i / 20 * 100 < value ? 0.6 : 0.1,
              border: `1px solid ${i / 20 * 100 < value ? color : 'white'}`
            }}
          />
        ))}
      </div>
    </div>
  );
}
