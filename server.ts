import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";

interface Node {
  id: string;
  name: string;
  x: number;
  y: number;
  ws: WebSocket;
  lastSeen: number;
  deliveryProbabilities: Record<string, number>;
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const wss = new WebSocketServer({ server });
  const nodes = new Map<string, Node>();

  wss.on("connection", (ws) => {
    const nodeId = uuidv4();
    
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case "REGISTER":
            nodes.set(nodeId, {
              id: nodeId,
              name: message.name,
              x: message.x || Math.random() * 100,
              y: message.y || Math.random() * 100,
              ws,
              lastSeen: Date.now(),
              deliveryProbabilities: {}
            });
            ws.send(JSON.stringify({ type: "REGISTERED", id: nodeId }));
            broadcastNetworkState();
            break;

          case "UPDATE_POSITION":
            const node = nodes.get(nodeId);
            if (node) {
              node.x = message.x;
              node.y = message.y;
              node.lastSeen = Date.now();
              updateEncounterProbabilities(node);
              broadcastNetworkState();
            }
            break;

          case "SEND_SOS":
            // Simulate "Physical Broadcast" - send to nearby nodes only
            relayToNeighbors(nodeId, message.payload);
            break;
        }
      } catch (e) {
        console.error("WS Message Error:", e);
      }
    });

    ws.on("close", () => {
      nodes.delete(nodeId);
      broadcastNetworkState();
    });
  });

  function updateEncounterProbabilities(node: Node) {
    const P_INIT = 0.75;
    const RANGE = 20; // Virtual units

    nodes.forEach((otherNode, otherId) => {
      if (otherId === node.id) return;

      const dist = Math.sqrt(Math.pow(node.x - otherNode.x, 2) + Math.pow(node.y - otherNode.y, 2));
      if (dist < RANGE) {
        // Increase probability on encounter
        node.deliveryProbabilities[otherId] = (node.deliveryProbabilities[otherId] || 0) + (1 - (node.deliveryProbabilities[otherId] || 0)) * P_INIT;
        otherNode.deliveryProbabilities[node.id] = (otherNode.deliveryProbabilities[node.id] || 0) + (1 - (otherNode.deliveryProbabilities[node.id] || 0)) * P_INIT;
      }
    });
  }

  function relayToNeighbors(senderId: string, payload: any) {
    const sender = nodes.get(senderId);
    if (!sender) return;

    const RANGE = 25; // Broadcast range
    nodes.forEach((node, id) => {
      if (id === senderId) return;
      const dist = Math.sqrt(Math.pow(sender.x - node.x, 2) + Math.pow(sender.y - node.y, 2));
      if (dist < RANGE) {
        node.ws.send(JSON.stringify({ type: "RECEIVE_SOS", payload, fromId: senderId }));
      }
    });
  }

  function broadcastNetworkState() {
    const state = Array.from(nodes.values()).map(n => ({
      id: n.id,
      name: n.name,
      x: n.x,
      y: n.y,
      probs: n.deliveryProbabilities
    }));
    
    nodes.forEach(node => {
      node.ws.send(JSON.stringify({ type: "NETWORK_STATE", nodes: state }));
    });
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }
}

startServer();
