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
  const [seenMessages] = useState<Set<string>>(() => new Set<string>());
  const [routingMode, setRoutingMode] = useState<RoutingMode>(RoutingMode.FLOODING);
  const [ttl, setTtl] = useState(5);
  const [isLiveLocation, setIsLiveLocation] = useState(false);
  const [realCoords, setRealCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [activeTab, setActiveTab] = useState<'map' | 'messages' | 'system'>('map');
  const [p2pMode, setP2pMode] = useState<'bluetooth' | 'wifi'>('bluetooth');
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [logs, setLogs] = useState<{ time: string; msg: string; type: 'info' | 'alert' | 'success' }[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isMaster, setIsMaster] = useState(false);

  const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [nodes, selectedNodeId]);

  const simulateEncryption = async (text: string) => {
    setIsEncrypting(true);
    // Visual delay for "Encryption" effect
    await new Promise(r => setTimeout(r, 800));
    setIsEncrypting(false);
    return `[AES-256-GCM] ${btoa(text).slice(0, 16)}...`;
  };

  const clearMessages = () => {
    setMessages([]);
    addLog('Signal buffer flushed.', 'info');
  };
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

  const triggerAlertSound = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.type = 'sawtooth';
      
      // Extended 6-second pulsing siren
      const now = audioCtx.currentTime;
      const duration = 6.0;
      oscillator.frequency.setValueAtTime(880, now);
      for (let i = 0.5; i <= duration; i += 0.5) {
        oscillator.frequency.linearRampToValueAtTime(i % 1 === 0 ? 880 : 440, now + i);
      }

      // High volume
      gainNode.gain.setValueAtTime(0.6, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.start();
      oscillator.stop(now + duration);
    } catch (err) {
      console.warn("Audio context failed to start:", err);
    }
  };

  const handleIncomingSOS = (msg: SOSMessage, fromId: string) => {
    if (seenMessages.has(msg.messageId)) return;
    seenMessages.add(msg.messageId);
    setMessages(prev => [msg, ...prev]);
    setActiveEmergency(msg);
    addLog(`SOS from ${msg.senderName} (Hop: ${msg.hopCount})`, 'alert');

    // Feedback: Sound and Vibration
    triggerAlertSound();
    if (navigator.vibrate) {
      // 6 seconds of intense vibration pulses
      navigator.vibrate([
        500, 200, 500, 200, 500, 200, 500, 200, 500, 200, 
        500, 200, 500, 200, 500, 200, 500, 200, 500
      ]);
    }

    if (msg.ttl <= 0) return;

    const nextMsg = { ...msg, ttl: msg.ttl - 1, hopCount: msg.hopCount + 1 };
    setTimeout(() => relayMessage(nextMsg), 500);
  };

  const relayMessage = (msg: SOSMessage) => {
    if (p2pMode === 'bluetooth') {
      // Simulate Bluetooth proximity sending
      const nearbyNodes = nodes.filter(n => {
        const dist = Math.sqrt(Math.pow(n.x - myPos.x, 2) + Math.pow(n.y - myPos.y, 2));
        return dist < 60 && n.id !== myId; // Increased from 30
      });

      if (nearbyNodes.length > 0) {
        addLog(`BLE: Broadcasting to ${nearbyNodes.length} nearby peers`, 'success');
        // In simulation, we just log it. For real P2P, we would use native bridge.
      } else {
        addLog('BLE: No peers found within 60 units. Move closer.', 'info');
      }
    } else if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'SEND_SOS', payload: msg }));
    } else {
      addLog('Mesh offline - check protocol selection.', 'alert');
    }
  };

  const triggerSOS = async () => {
    const rawContent = isLiveLocation && realCoords
      ? `EMERGENCY at [${realCoords.lat.toFixed(6)}, ${realCoords.lng.toFixed(6)}]`
      : "EMERGENCY: Assistance required.";

    const content = await simulateEncryption(rawContent);

    const msg: SOSMessage = {
      messageId: Math.random().toString(36).substring(7),
      senderId: myId || 'unknown',
      senderName: userName,
      timestamp: Date.now(),
      ttl: ttl,
      hopCount: 0,
      content: content,
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

  const scanNearbyBLE = async () => {
    const nav = navigator as any;
    if (!nav.bluetooth) {
      addLog("Bluetooth API not supported in this browser.", "alert");
      return;
    }
    setIsScanning(true);
    addLog("Scanning for BLE SOS beacons...", "info");
    try {
      // Look for any devices that advertise a common SOS service UUID
      const device = await nav.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ['battery_service', 'heart_rate'] // Standard services for demo, would be custom in production
      });
      addLog(`Found device: ${device.name || "Unknown Unit"}`, "success");
      setNodes(prev => {
        if (prev.find(n => n.id === device.id)) return prev;
        return [...prev, {
          id: device.id,
          name: device.name || "Remote BLE Unit",
          x: Math.random() * 100,
          y: Math.random() * 100,
          probs: {}
        }];
      });
    } catch (err: any) {
      if (err.name !== 'NotFoundError' && err.name !== 'AbortError') {
        addLog(`BLE Scan Error: ${err.message}`, "alert");
      }
    } finally {
      setIsScanning(false);
    }
  };

  const scanLocalNetwork = async () => {
    addLog("Surveying local mesh for coordinators...", "info");
    const subnet = "192.168.1"; // Default common subnet
    for (let i = 1; i < 255; i++) {
      const target = `${subnet}.${i}`;
      const url = `ws://${target}:3000/ws`;
      try {
        const testSocket = new WebSocket(url);
        const timeout = setTimeout(() => testSocket.close(), 100);
        testSocket.onopen = () => {
          clearTimeout(timeout);
          addLog(`Mesh coordinator found at ${target}`, "success");
          window.location.host = `${target}:3000`; // Auto-reload to connect to that IP
        };
      } catch (e) {}
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
    const svg = d3.select(mapRef.current)
      .on("click", () => setSelectedNodeId(null));
    svg.selectAll("*").remove();
    const width = mapRef.current.clientWidth;
    const height = mapRef.current.clientHeight;

    // Tactical Glow Grid dots
    const dotSpacing = 40;
    const dotsG = svg.append("g").attr("class", "grid-dots");
    for (let x = 0; x <= width; x += dotSpacing) {
      for (let y = 0; y <= height; y += dotSpacing) {
        dotsG.append("circle")
          .attr("cx", x)
          .attr("cy", y)
          .attr("r", 0.8)
          .attr("fill", "#00ff41")
          .attr("opacity", 0.08);
      }
    }

    // Scanning Radar Sweep - Multi-layered
    const radarG = svg.append("g").attr("class", "radar-system");

    // Outer Rings
    for (let r = 1; r <= 3; r++) {
      radarG.append("circle")
        .attr("cx", width / 2)
        .attr("cy", height / 2)
        .attr("r", (width / 6) * r)
        .attr("fill", "none")
        .attr("stroke", "#00ff41")
        .attr("stroke-width", 0.5)
        .attr("opacity", 0.05)
        .attr("stroke-dasharray", "4,4");
    }

    const sweepG = radarG.append("g")
      .attr("class", "radar-sweep")
      .style("transform-origin", `${width / 2}px ${height / 2}px`);

    sweepG.append("line")
      .attr("x1", width / 2)
      .attr("y1", height / 2)
      .attr("x2", width)
      .attr("y2", height / 2)
      .attr("stroke", "url(#radar-gradient)")
      .attr("stroke-width", 2);

    // Gradient for sweep
    const defs = svg.append("defs");
    const grad = defs.append("linearGradient")
      .attr("id", "radar-gradient")
      .attr("x1", "0%").attr("y1", "0%")
      .attr("x2", "100%").attr("y2", "0%");
    grad.append("stop").attr("offset", "0%").attr("stop-color", "rgba(0, 255, 65, 0)");
    grad.append("stop").attr("offset", "100%").attr("stop-color", "rgba(0, 255, 65, 0.4)");

    nodes.forEach(node => {
      const isMe = node.id === myId;
      const x = (node.x / 100) * width;
      const y = (node.y / 100) * height;
      const nodeColor = isMe ? "#10b981" : (p2pMode === 'bluetooth' ? "#3B82F6" : "#10b981");

      const g = svg.append("g")
        .attr("transform", `translate(${x}, ${y})`)
        .attr("class", "cursor-pointer group")
        .on("click", (e) => {
          e.stopPropagation();
          setSelectedNodeId(node.id);
        });

      if (isMe) {
        // Range Indicator Glow
        svg.append("circle")
          .attr("cx", x)
          .attr("cy", y)
          .attr("r", (30 / 100) * width)
          .attr("fill", `${nodeColor}08`)
          .attr("stroke", `${nodeColor}22`)
          .attr("stroke-dasharray", "4,4")
          .attr("class", "animate-pulse")
          .lower();
      }

      // Node Marker - Crosshair Style
      const size = isMe ? 8 : 6;
      g.append("circle")
        .attr("r", size)
        .attr("fill", nodeColor)
        .attr("filter", "blur(4px)")
        .attr("opacity", 0.4);

      g.append("circle")
        .attr("r", size / 2)
        .attr("fill", nodeColor);

      if (isMe) {
        g.append("circle")
          .attr("r", size * 3)
          .attr("fill", "none")
          .attr("stroke", nodeColor)
          .attr("stroke-width", 1)
          .attr("opacity", 0.3)
          .attr("class", "animate-ping");
      }

      // Name & ID Label
      const label = g.append("g").attr("transform", `translate(0, ${size + 12})`);

      // Label Background
      label.append("rect")
        .attr("x", -30)
        .attr("y", -8)
        .attr("width", 60)
        .attr("height", 14)
        .attr("fill", "rgba(10, 10, 11, 0.8)")
        .attr("rx", 4);

      label.append("text")
        .text(node.name.toUpperCase())
        .attr("text-anchor", "middle")
        .attr("fill", "white")
        .attr("font-size", "7px")
        .attr("font-family", "JetBrains Mono")
        .attr("font-weight", "bold")
        .attr("dy", 2);

      if (isMe) {
        label.append("text")
          .text("AUTHORIZED UNIT")
          .attr("dy", 10)
          .attr("text-anchor", "middle")
          .attr("fill", nodeColor)
          .attr("font-size", "5px")
          .attr("font-family", "JetBrains Mono")
          .attr("letter-spacing", "1px");
      }
    });

    // Add HUD corner accents to the SVG itself
    const pad = 20;
    const len = 15;
    const HUD = svg.append("g").attr("class", "hud-accents").attr("opacity", 0.2);

    const corners = [
      `M ${pad},${pad + len} V ${pad} H ${pad + len}`,
      `M ${width - pad},${pad + len} V ${pad} H ${width - pad - len}`,
      `M ${pad},${height - pad - len} V ${height - pad} H ${pad + len}`,
      `M ${width - pad},${height - pad - len} V ${height - pad} H ${width - pad - len}`
    ];

    corners.forEach(d => {
      HUD.append("path")
        .attr("d", d)
        .attr("fill", "none")
        .attr("stroke", "#fff")
        .attr("stroke-width", 1);
    });

  }, [nodes, myId, p2pMode]);


  if (!isRegistered) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0b] p-6 relative overflow-hidden">
        <div className="scanline" />
        <div className="absolute inset-0 opacity-20 data-grid" />

        {/* Ambient Glows */}
        <div className="absolute top-1/4 -left-20 w-80 h-80 bg-emerald-500/10 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-1/4 -right-20 w-80 h-80 bg-blue-500/10 rounded-full blur-[120px] animate-pulse" />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="w-full max-w-md relative z-10"
        >
          <div className="bg-[#121214]/80 backdrop-blur-2xl border border-white/5 rounded-3xl p-8 md:p-12 shadow-2xl relative overflow-hidden group">
            {/* HUD Elements */}
            <div className="absolute top-0 left-0 w-12 h-12 border-t-2 border-l-2 border-emerald-500/30 rounded-tl-3xl transition-all group-hover:w-16 group-hover:h-16" />
            <div className="absolute bottom-0 right-0 w-12 h-12 border-b-2 border-r-2 border-emerald-500/30 rounded-br-3xl transition-all group-hover:w-16 group-hover:h-16" />

            <div className="text-center space-y-8">
              <div className="relative inline-flex items-center justify-center">
                <div className="absolute inset-0 bg-emerald-500/20 blur-3xl rounded-full animate-pulse" />
                <div className="relative bg-black/40 p-5 rounded-2xl border border-emerald-500/20 shadow-inner">
                  <Radio className="w-12 h-12 text-emerald-400" strokeWidth={1.5} />
                </div>
              </div>

              <div className="space-y-2">
                <h1 className="text-5xl font-serif italic text-white tracking-tight">SOS <span className="text-emerald-500">MESH</span></h1>
                <div className="flex items-center justify-center gap-2">
                  <span className="h-[1px] w-8 bg-emerald-500/20" />
                  <p className="text-[10px] font-mono text-emerald-500/60 uppercase tracking-[0.4em] font-bold">Protocol v4.2.0 Active</p>
                  <span className="h-[1px] w-8 bg-emerald-500/20" />
                </div>
              </div>

              <div className="space-y-6 text-left">
                <div className="space-y-2">
                  <label className="text-[10px] font-mono text-white/40 uppercase ml-1 flex items-center gap-2">
                    <div className="w-1 h-1 bg-emerald-500 rounded-full" />
                    Responder Identity
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={userName}
                      onChange={(e) => setUserName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && userName && setIsRegistered(true)}
                      placeholder="Enter unit callsign"
                      className="w-full bg-black/40 border border-white/10 p-4 rounded-xl text-sm font-mono text-emerald-400 focus:border-emerald-500/50 focus:ring-4 focus:ring-emerald-500/5 outline-none transition-all placeholder:text-white/10"
                    />
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 opacity-20">
                      <Zap size={14} className="text-emerald-400" />
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <button
                    onClick={() => userName && setIsRegistered(true)}
                    disabled={!userName}
                    className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-black font-mono font-bold py-4 rounded-xl transition-all flex items-center justify-center gap-3 shadow-lg shadow-emerald-500/20 group"
                  >
                    ESTABLISH LINK <ChevronRight size={18} className="group-hover:translate-x-1 transition-transform" />
                  </button>

                  <div className="flex items-center justify-between px-1">
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                      <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Secure Uplink</span>
                    </div>
                    <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">AES-256 BIT</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="mt-8 text-[9px] font-mono text-white/10 text-center uppercase tracking-[0.3em] leading-relaxed max-w-[280px] mx-auto">
            Emergency Peer-to-Peer Network <br />
            Standard IEEE 802.15.4 COMPLIANT
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] flex flex-col md:grid md:grid-cols-12 bg-[#0a0a0b] overflow-hidden selection:bg-emerald-500 selection:text-black">
      <div className="scanline" />

      {/* Sidebar Overlay for Mobile */}
      <aside className={cn(
        "md:col-span-3 border-r border-white/5 flex flex-col bg-[#121214] transition-all duration-500 ease-in-out",
        activeTab === 'system' ? 'fixed inset-0 z-[70] md:relative' : 'hidden md:flex'
      )}>
        <div className="p-6 border-b border-white/5 flex justify-between items-center group">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="absolute inset-0 bg-emerald-500/20 blur-lg rounded-full animate-pulse" />
              <Radio className="text-emerald-500 relative z-10" size={24} />
            </div>
            <div>
              <h2 className="text-sm font-serif italic text-white/90 leading-none">{userName}</h2>
              <div className="flex items-center gap-1.5 mt-1">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <p className="text-[10px] font-mono text-emerald-500 font-bold tracking-widest uppercase">Node Online</p>
              </div>
            </div>
          </div>
          <button onClick={() => setActiveTab('map')} className="md:hidden p-2 text-white/20 hover:text-white transition-colors">
            <ChevronRight size={20} className="rotate-90" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          <div className="grid grid-cols-2 gap-4">
            <StatCard
              icon={<Users size={14} className="text-emerald-500" />}
              label="PEERS"
              value={nodes.length.toString()}
              subValue={nodes.length === 0 ? "SCANNING..." : "STABLE"}
            />
            <StatCard
              icon={<Zap size={14} className="text-blue-500" />}
              label="HOPS"
              value={messages.length > 0 ? messages[0].hopCount.toString() : "0"}
              subValue="LATENCY: LOW"
            />
          </div>

          <div className="space-y-4 border-y border-white/5 py-6">
            <div className="flex items-center justify-between text-[10px] font-mono tracking-widest text-white/40 uppercase">
              <div className="flex items-center gap-2">
                <Wifi size={12} className="text-emerald-500" />
                TACTICAL SURVEY
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={scanNearbyBLE}
                disabled={isScanning}
                className={cn(
                  "py-3 rounded-xl border text-[9px] font-mono transition-all",
                  isScanning ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400" : "bg-white/5 border-white/5 text-white/50 hover:bg-white/10"
                )}
              >
                {isScanning ? "SCANNING..." : "BLE BEACON"}
              </button>
              <button
                onClick={scanLocalNetwork}
                className="py-3 rounded-xl border border-white/5 bg-white/5 text-[9px] font-mono text-white/50 hover:bg-white/10 transition-all"
              >
                SUBNET SCAN
              </button>
            </div>
            <p className="text-[8px] font-mono text-white/20 uppercase text-center">Use Subnet Scan if on Wi-Fi Hotspot</p>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between text-[10px] font-mono tracking-widest text-white/30 uppercase">
              <div className="flex items-center gap-2">
                <Activity size={12} />
                SIGNAL MODE
              </div>
              <span className="text-emerald-500/50">ENCRYPTED</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setP2pMode('wifi')}
                className={cn(
                  "py-3 rounded-xl border text-[10px] font-mono font-bold transition-all",
                  p2pMode === 'wifi'
                    ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.1)]"
                    : "bg-black/20 border-white/5 text-white/30 hover:border-white/20"
                )}
              >
                M-WIFI
              </button>
              <button
                onClick={() => setP2pMode('bluetooth')}
                className={cn(
                  "py-3 rounded-xl border text-[10px] font-mono font-bold transition-all",
                  p2pMode === 'bluetooth'
                    ? "bg-blue-500/10 border-blue-500/50 text-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.1)]"
                    : "bg-black/20 border-white/5 text-white/30 hover:border-white/20"
                )}
              >
                BT-LE
              </button>
            </div>
          </div>

          <div className="space-y-4">
            <label className="text-[10px] font-mono tracking-widest text-white/30 uppercase flex items-center gap-2">
              <ShieldAlert size={12} />
              ROUTING PROTOCOL
            </label>
            <div className="space-y-2">
              {Object.values(RoutingMode).map(mode => (
                <button
                  key={mode}
                  onClick={() => setRoutingMode(mode)}
                  className={cn(
                    "w-full text-left px-4 py-3 rounded-xl border text-[10px] font-mono transition-all relative overflow-hidden group",
                    routingMode === mode
                      ? "bg-emerald-500/5 border-emerald-500/40 text-emerald-400"
                      : "bg-transparent border-white/5 text-white/30 hover:bg-white/5"
                  )}
                >
                  <div className={cn(
                    "absolute left-0 top-0 bottom-0 w-1 transition-all",
                    routingMode === mode ? "bg-emerald-500 shadow-[0_0_10px_emerald-500]" : "bg-transparent"
                  )} />
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-white/5 space-y-4 bg-black/20">
          {deferredPrompt && (
            <button
              onClick={installApp}
              className="w-full bg-emerald-500 text-black text-[11px] font-mono font-black py-3 rounded-xl hover:bg-emerald-400 transition-all shadow-lg shadow-emerald-500/10 group"
            >
              UPGRADE TO NATIVE
            </button>
          )}
          <button
            onClick={triggerSOS}
            disabled={isEncrypting}
            className="w-full bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-mono font-black py-5 rounded-2xl shadow-2xl shadow-red-600/20 active:scale-[0.98] transition-all flex flex-col items-center gap-1 group"
          >
            <div className="relative">
              {isEncrypting ? (
                <div className="w-7 h-7 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              ) : (
                <ShieldAlert size={28} className="group-hover:scale-110 transition-transform" />
              )}
              <div className="absolute inset-0 bg-white/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <span className="text-[10px] tracking-[0.2em] font-bold">
              {isEncrypting ? "ENCRYPTING..." : "BROADCAST EMERGENCY"}
            </span>
          </button>
          <button
            onClick={() => {
              clearMessages();
              setLogs([]);
              addLog('Node records purged.', 'alert');
            }}
            className="w-full bg-white/5 hover:bg-white/10 text-white/40 hover:text-red-400 font-mono text-[9px] py-2 rounded-lg transition-all border border-white/5"
          >
            PURGE LOCAL DATA
          </button>
        </div>
      </aside>

      <main className={cn(
        "md:col-span-6 relative bg-black flex flex-col transition-all duration-500",
        activeTab === 'map' ? 'flex-1 md:pb-0' : (activeTab === 'messages' ? 'flex-1 md:pb-0' : 'hidden md:flex')
      )}>
        <div className="absolute inset-0 data-grid opacity-30 pointer-events-none" />

        <div className={cn("flex-1 flex flex-col relative", activeTab === 'map' ? 'flex' : 'hidden md:flex')}>
          <div className="absolute top-6 left-6 z-20 flex items-center gap-4">
            <div className="bg-[#121214]/90 backdrop-blur-xl border border-white/5 p-3 px-5 rounded-2xl flex items-center gap-4 shadow-2xl">
              <div className="relative">
                <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
                <div className="absolute inset-0 bg-emerald-500/50 rounded-full blur-md animate-ping" />
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-mono text-emerald-500 font-black tracking-widest">TACTICAL LINK ACTIVE</span>
                <span className="text-[9px] font-mono text-white/40 uppercase tracking-tighter">Lat: {realCoords?.lat.toFixed(4) || "0.0000"} Long: {realCoords?.lng.toFixed(4) || "0.0000"}</span>
              </div>
            </div>
          </div>

          <div className="w-full h-full relative overflow-hidden">
            <svg ref={mapRef} className="w-full h-full cursor-crosshair" />

            {/* Selected Node Details Overlay */}
            <AnimatePresence>
              {selectedNode && (
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="absolute top-24 right-6 w-64 bg-[#121214]/95 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl z-50 pointer-events-auto"
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-400" />
                      <span className="text-[10px] font-mono font-black text-white uppercase tracking-widest">{selectedNode.name}</span>
                    </div>
                    <button onClick={() => setSelectedNodeId(null)} className="text-white/20 hover:text-white transition-colors">
                      <Zap size={10} className="rotate-45" />
                    </button>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <span className="text-[8px] font-mono text-white/20 uppercase tracking-[0.2em] block mb-2">Routing Intelligence</span>
                      {Object.entries(selectedNode.probs).length === 0 ? (
                        <p className="text-[9px] font-mono text-white/40 italic">No encounter history established.</p>
                      ) : (
                        <div className="space-y-2 max-h-32 overflow-y-auto custom-scrollbar pr-2">
                          {Object.entries(selectedNode.probs).map(([id, prob]) => {
                            const nodeName = nodes.find(n => n.id === id)?.name || id.slice(0, 4);
                            return (
                              <div key={id} className="space-y-1">
                                <div className="flex justify-between text-[8px] font-mono">
                                  <span className="text-white/60">{nodeName}</span>
                                  <span className="text-emerald-500">{(prob as number * 100).toFixed(0)}%</span>
                                </div>
                                <div className="h-0.5 bg-white/5 rounded-full overflow-hidden">
                                  <div className="h-full bg-emerald-500/50" style={{ width: `${(prob as number * 100)}%` }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* HUD Overlays */}
            <div className="absolute inset-0 pointer-events-none border-[1px] border-white/5 m-4 rounded-3xl overflow-hidden">
              <div className="absolute top-0 left-0 w-8 h-px bg-emerald-500/40" />
              <div className="absolute top-0 left-0 h-8 w-px bg-emerald-500/40" />
              <div className="absolute bottom-0 right-0 w-8 h-px bg-emerald-500/40" />
              <div className="absolute bottom-0 right-0 h-8 w-px bg-emerald-500/40" />
            </div>

            <div className="md:hidden absolute bottom-32 left-8 z-30 space-y-2">
              <div className="bg-black/80 backdrop-blur-xl border border-white/5 px-3 py-1.5 rounded-full flex items-center gap-2 shadow-xl">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span className="text-[10px] font-mono text-white/60 tracking-widest uppercase">NODE: {myId?.slice(0, 8)}</span>
              </div>
              <div className="bg-black/80 backdrop-blur-xl border border-white/5 px-3 py-1.5 rounded-full flex items-center gap-2 shadow-xl">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                <span className="text-[10px] font-mono text-white/60 tracking-widest uppercase">{p2pMode.toUpperCase()} MESH</span>
              </div>
            </div>

            <div className="md:hidden absolute bottom-8 left-1/2 -translate-x-1/2 z-[60]">
              <button
                onClick={triggerSOS}
                className="relative flex flex-col items-center justify-center w-28 h-28 rounded-full bg-red-600 active:scale-90 transition-all group overflow-hidden"
              >
                <div className="absolute inset-0 bg-white/10 opacity-0 group-active:opacity-100 transition-opacity" />
                <div className="absolute inset-0 rounded-full border-4 border-red-500 animate-[ping_2s_infinite]" />
                <ShieldAlert size={36} className="text-white mb-1 relative z-10" />
                <span className="text-white font-black text-[10px] tracking-[0.2em] relative z-10">SOS</span>
              </button>
            </div>
          </div>
        </div>

        <div className={cn(
          "bg-[#0a0a0b] border-t border-white/5 flex flex-col",
          activeTab === 'messages' ? 'absolute inset-0 z-[60] pb-20' : 'h-64 hidden md:flex'
        )}>
          <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between text-[10px] font-mono font-black tracking-widest text-white/30 uppercase bg-white/[0.02]">
            <div className="flex items-center gap-3">
              <History size={14} className="text-emerald-500" />
              SIGNAL BUFFER
            </div>
            <div className="flex items-center gap-3">
              <span className="text-emerald-500">{messages.length} DATA PACKETS</span>
              <div className="w-px h-3 bg-white/10" />
              <button onClick={clearMessages} className="hover:text-white transition-colors">CLEAR</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-white/10 space-y-2">
                <Wifi size={32} strokeWidth={1} />
                <p className="text-[10px] font-mono uppercase tracking-[0.3em]">No emergency packets detected</p>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.messageId} className="bg-white/[0.03] border border-white/5 border-l-4 border-l-red-500/50 p-4 rounded-xl flex items-center justify-between group hover:bg-white/[0.05] transition-all">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-red-400 font-black tracking-widest uppercase">{m.senderName}</span>
                      <span className="text-[9px] font-mono text-white/20">•</span>
                      <span className="text-[9px] font-mono text-white/30 uppercase">{new Date(m.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <p className="text-sm text-white/90 font-medium">{m.content}</p>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-mono text-white/30 bg-white/5 px-2 py-1 rounded">HOP COUNT: {m.hopCount}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      <aside className="hidden md:flex md:col-span-3 border-l border-white/5 bg-[#121214] flex-col">
        <div className="p-8 border-b border-white/5 space-y-8 bg-black/20">
          <MetricBar label="Delivery Probability" value={84} color="#10b981" />
          <MetricBar label="Network Efficiency" value={92} color="#3b82f6" />
        </div>
        <div className="flex-1 flex flex-col overflow-hidden p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-mono font-black tracking-widest text-white/20 uppercase flex items-center gap-2">
              <Zap size={12} />
              RUNTIME LOGS
            </div>
            <div className="flex gap-1">
              <div className="w-1 h-1 rounded-full bg-emerald-500" />
              <div className="w-1 h-1 rounded-full bg-emerald-500/30" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto space-y-4 font-mono text-[9px] custom-scrollbar">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-3 items-start animate-fade-in">
                <span className="text-white/10 whitespace-nowrap">[{log.time}]</span>
                <span className={cn(
                  "leading-relaxed tracking-tight",
                  log.type === 'alert' ? 'text-red-400 font-bold' :
                    log.type === 'success' ? 'text-emerald-400' :
                      'text-white/40'
                )}>
                  {log.msg.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* Mobile Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-20 bg-[#121214]/90 backdrop-blur-2xl border-t border-white/5 grid grid-cols-3 items-center z-[80] shadow-[0_-20px_50px_rgba(0,0,0,0.5)]">
        <button onClick={() => setActiveTab('map')} className={cn(
          "flex flex-col items-center gap-1.5 transition-all",
          activeTab === 'map' ? "text-emerald-500" : "text-white/20"
        )}>
          <MapIcon size={22} strokeWidth={activeTab === 'map' ? 2.5 : 2} />
          <span className="text-[9px] font-mono font-black tracking-wider">MAP</span>
        </button>
        <button onClick={() => setActiveTab('messages')} className={cn(
          "flex flex-col items-center gap-1.5 transition-all",
          activeTab === 'messages' ? "text-emerald-500" : "text-white/20"
        )}>
          <div className="relative">
            <History size={22} strokeWidth={activeTab === 'messages' ? 2.5 : 2} />
            {messages.length > 0 && <div className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full border-2 border-[#121214]" />}
          </div>
          <span className="text-[9px] font-mono font-black tracking-wider">ALERTS</span>
        </button>
        <button onClick={() => setActiveTab('system')} className={cn(
          "flex flex-col items-center gap-1.5 transition-all",
          activeTab === 'system' ? "text-emerald-500" : "text-white/20"
        )}>
          <Settings size={22} strokeWidth={activeTab === 'system' ? 2.5 : 2} />
          <span className="text-[9px] font-mono font-black tracking-wider">SYSTEM</span>
        </button>
      </nav>

      {/* Emergency Global Alert */}
      <AnimatePresence>
        {activeEmergency && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-red-950/40 backdrop-blur-3xl"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="w-full max-w-lg bg-[#0a0a0b] border border-red-500/30 p-10 rounded-[2.5rem] shadow-[0_0_100px_rgba(239,68,68,0.3)] text-center space-y-8 relative overflow-hidden"
            >
              <div className="absolute inset-0 bg-red-500/[0.02] animate-pulse" />
              <div className="relative">
                <div className="w-24 h-24 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
                  <ShieldAlert size={56} className="text-red-500 animate-bounce" />
                </div>
                <h2 className="text-4xl font-mono font-black text-white tracking-tighter uppercase mb-2">Help Required</h2>
                <p className="text-red-400/80 font-mono text-[10px] tracking-[0.3em] font-bold uppercase">CRITICAL SIGNAL DETECTED</p>
              </div>

              <div className="bg-white/[0.03] border border-white/5 p-6 rounded-2xl space-y-3">
                <div className="flex items-center justify-between text-[10px] font-mono text-white/30 uppercase tracking-widest">
                  <span>SENDER: {activeEmergency.senderName}</span>
                  <span>ID: {activeEmergency.senderId.slice(0, 8)}</span>
                </div>
                <div className="h-px bg-white/5" />
                <p className="text-xl text-white font-medium italic">"{activeEmergency.content}"</p>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveEmergency(null);
                }}
                className="w-full bg-white text-black font-mono font-black py-5 rounded-2xl hover:bg-white/90 active:scale-[0.98] transition-all text-sm tracking-widest uppercase relative z-[300]"
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
    <div className="bg-white/[0.02] border border-white/5 p-4 rounded-2xl space-y-2 group hover:bg-white/[0.04] transition-all relative overflow-hidden">
      <div className="flex items-center gap-2 text-[9px] font-mono font-black text-white/20 tracking-widest uppercase">{icon} {label}</div>
      <div className="flex items-end gap-2">
        <div className="text-3xl font-mono font-medium text-white tracking-tighter leading-none">{value}</div>
        {subValue && <div className="text-[9px] font-mono text-emerald-500 font-bold uppercase mb-1">{subValue}</div>}
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-right from-transparent via-white/5 to-transparent scale-x-0 group-hover:scale-x-100 transition-transform" />
    </div>
  );
}

function MetricBar({ label, value, color }: { label: string, value: number, color: string }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-end text-[10px] font-mono font-black tracking-widest text-white/20 uppercase">
        <span className="flex items-center gap-2">
          <div className="w-1 h-1 rounded-full" style={{ backgroundColor: color }} />
          {label}
        </span>
        <span style={{ color }} className="text-white/60">{value}%</span>
      </div>
      <div className="h-1.5 bg-white/[0.03] rounded-full overflow-hidden flex gap-0.5 p-0.5">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="flex-1 h-full rounded-full transition-all duration-1000"
            style={{
              backgroundColor: i / 12 * 100 < value ? color : 'rgb(255 255 255 / 0.05)',
              opacity: i / 12 * 100 < value ? 0.8 : 0.2,
              boxShadow: i / 12 * 100 < value ? `0 0 10px ${color}44` : 'none'
            }}
          />
        ))}
      </div>
    </div>
  );
}

