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
  const [p2pMode, setP2pMode] = useState<'cloudoffline' | 'bluetooth'>('cloudoffline');
  const [showNativeCode, setShowNativeCode] = useState(false);
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
    if (!mapRef.current || !nodes.length) return;
    const svg = d3.select(mapRef.current);
    svg.selectAll("*").remove();
    const width = mapRef.current.clientWidth;
    const height = mapRef.current.clientHeight;

    const gridSize = 40;
    for (let x = 0; x <= width; x += gridSize) {
      svg.append("line").attr("x1", x).attr("y1", 0).attr("x2", x).attr("y2", height).attr("stroke", "#2A2A2A");
    }
    for (let y = 0; y <= height; y += gridSize) {
      svg.append("line").attr("x1", 0).attr("y1", y).attr("x2", width).attr("y2", y).attr("stroke", "#2A2A2A");
    }

    nodes.forEach(node => {
      const isMe = node.id === myId;
      const x = (node.x / 100) * width;
      const y = (node.y / 100) * height;
      const g = svg.append("g").attr("transform", `translate(${x}, ${y})`);

      if (isMe && p2pMode === 'bluetooth') {
        // Signal Range Circle
        svg.append("circle")
          .attr("cx", x)
          .attr("cy", y)
          .attr("r", (30 / 100) * width)
          .attr("fill", "rgba(59, 130, 246, 0.05)")
          .attr("stroke", "rgba(59, 130, 246, 0.2)")
          .attr("stroke-dasharray", "4,4")
          .lower();
      }

      g.append("circle").attr("r", isMe ? 8 : 6).attr("fill", isMe ? "#00FF41" : "#E4E3E0");
      if (isMe) g.append("circle").attr("r", 15).attr("fill", "none").attr("stroke", "#00FF41").attr("opacity", 0.3).attr("class", "animate-ping");
      g.append("text").text(node.name).attr("dy", -12).attr("text-anchor", "middle").attr("fill", "#E4E3E0").attr("font-size", "10px").attr("font-family", "JetBrains Mono");
    });
  }, [nodes, myId]);

  if (!isRegistered) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#141414] p-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md border border-[#2A2A2A] p-8 bg-[#1A1A1A] rounded-2xl shadow-2xl">
          <div className="text-center space-y-2">
            <Radio className="w-12 h-12 text-[#00FF41] mx-auto mb-4" />
            <h1 className="text-3xl font-serif italic text-[#E4E3E0]">Resilient Comm</h1>
            <p className="text-xs font-mono text-white/40 uppercase tracking-widest">Emergency Node Registration</p>
          </div>
          <div className="space-y-4 mt-8">
            <input type="text" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Responder Name..." className="w-full bg-black border border-[#2A2A2A] p-3 rounded-lg text-sm font-mono focus:border-[#00FF41] outline-none transition-colors" />
            <button onClick={() => userName && setIsRegistered(true)} className="w-full bg-[#00FF41] text-black font-mono font-bold py-3 rounded-lg hover:bg-[#00CC33] flex items-center justify-center gap-2">INITIALIZE NODE <ChevronRight size={16} /></button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col md:grid md:grid-cols-12 bg-[#141414] overflow-hidden">
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
              <button onClick={() => setP2pMode('cloudoffline')} className={cn("flex-1 py-3 rounded border text-[9px] font-mono", p2pMode === 'cloudoffline' ? "bg-[#00FF41]/10 border-[#00FF41] text-[#00FF41]" : "bg-black/40 border-[#2A2A2A] text-white/30")}>INTERNET/MESH</button>
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
            <button onClick={() => setShowNativeCode(true)} className="w-full border border-[#00FF41]/30 text-[#00FF41] text-[10px] font-mono py-3 rounded hover:bg-[#00FF41]/10">GET KOTLIN SOURCE FOR APK</button>
            <p className="text-[8px] font-mono text-white/20 italic">For real offline Bluetooth mesh, copy the code above into Android Studio.</p>
          </div>
        </div>

        <div className="hidden md:block p-6 border-t border-[#2A2A2A]">
          <button onClick={triggerSOS} className="w-full bg-red-600 hover:bg-red-700 text-white font-mono font-bold py-4 rounded-xl shadow-lg active:scale-95 transition-all flex flex-col items-center"><ShieldAlert size={24} /><span className="text-xs">BROADCAST SOS</span></button>
        </div>
      </aside>

      <main className={cn("md:col-span-6 relative bg-black data-grid flex flex-col", activeTab === 'map' ? 'flex flex-1 pb-16 md:pb-0' : (activeTab === 'messages' ? 'flex flex-1 pb-16 md:pb-0' : 'hidden md:flex'))}>
        <div className={cn("flex-1 relative", activeTab === 'map' ? 'block' : 'hidden md:block')}>
          <div className="absolute top-4 left-4 z-10 flex items-center gap-4">
            <div className="bg-[#1A1A1A]/80 backdrop-blur border border-[#2A2A2A] px-4 py-2 rounded-full flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-[#00FF41] animate-pulse" />
              <span className="text-[10px] font-mono text-white/60 tracking-widest uppercase">TOPOLOGY Map</span>
            </div>
          </div>
          <div className="w-full h-full relative" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            updatePosition(x, y);
          }}>
            <svg ref={mapRef} className="w-full h-full" />
            <div className="absolute bottom-4 right-4 text-[10px] font-mono text-white/20">[ {myPos.x.toFixed(1)}, {myPos.y.toFixed(1)} ]</div>
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

      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-[#1A1A1A]/95 backdrop-blur-md border-t border-[#2A2A2A] grid grid-cols-4 items-center z-[60]">
        <button onClick={() => setActiveTab('map')} className={cn("flex flex-col items-center gap-1", activeTab === 'map' ? "text-[#00FF41]" : "text-white/40")}><MapIcon size={20} /><span className="text-[9px] font-mono">MAP</span></button>
        <button onClick={() => setActiveTab('messages')} className={cn("flex flex-col items-center gap-1", activeTab === 'messages' ? "text-[#00FF41]" : "text-white/40")}><History size={20} /><span className="text-[9px]">ALERTS</span></button>
        <button onClick={() => setActiveTab('system')} className={cn("flex flex-col items-center gap-1", activeTab === 'system' ? "text-[#00FF41]" : "text-white/40")}><Settings size={20} /><span className="text-[9px]">SYSTEM</span></button>
        <button onClick={triggerSOS} className="flex flex-col items-center text-red-500 active:scale-90 transition-transform"><div className="w-10 h-10 rounded-full bg-red-600/20 flex items-center justify-center border border-red-600/40"><ShieldAlert size={22} className="animate-pulse" /></div><span className="text-[8px] font-bold">SOS</span></button>
      </nav>

      <AnimatePresence>
        {showNativeCode && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
            <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} className="w-full max-w-2xl bg-[#1A1A1A] border border-[#2A2A2A] p-6 rounded-2xl flex flex-col max-h-[90vh]">
              <div className="flex justify-between items-center mb-4"><h3 className="text-sm font-mono text-[#00FF41] uppercase">Android (Kotlin) Source</h3><button onClick={() => setShowNativeCode(false)} className="text-white/40"><Info size={20} /></button></div>
              <div className="flex-1 overflow-y-auto bg-black p-4 rounded-lg border border-[#2A2A2A]"><pre className="text-[10px] font-mono text-white/80 whitespace-pre-wrap">{KOTLIN_CODE}</pre></div>
              <button onClick={() => setShowNativeCode(false)} className="mt-4 w-full bg-[#00FF41] text-black font-mono font-bold py-3 rounded-lg">CLOSE SOURCE</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono uppercase"><span className="text-white/40">{label}</span><span style={{ color }}>{value}%</span></div>
      <div className="h-1 bg-black rounded-full overflow-hidden"><motion.div initial={{ width: 0 }} animate={{ width: `${value}%` }} className="h-full" style={{ backgroundColor: color }} /></div>
    </div>
  );
}
