import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";

const app = express();

// TEMP: allow all origins while we stand up the app (we'll lock this down later)
app.use(cors());
app.use(express.json());

// simple health check for Render/uptime pings
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// root message
app.get("/", (req, res) => {
  res.send("Vitaliage backend is running!");
});

// --- devices register endpoint (stub; will wire to DB later) ---
const devices = []; // in-memory store for now

app.post("/devices", (req, res) => {
  const { userId = null, platform, token } = req.body || {};

  if (!platform || !token) {
    return res.status(400).json({ error: "platform and token are required" });
  }

  const entry = {
    id: randomUUID(),
    userId,
    platform: String(platform).toLowerCase(),
    token,
    createdAt: new Date().toISOString(),
  };

  devices.push(entry);
  console.log("Device registered:", entry);

  res.status(201).json({ message: "Device token stored", device: entry });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
