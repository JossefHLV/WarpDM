/**
 * WarpDM (Warp Download Manager) - Main Server Entry Point
 * Boots the Download Engine, SQLite WAL storage, and Bridge Server.
 */

import { DownloadEngine } from "./core/engine.mjs";
import { BridgeServer } from "./bridge/server.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 20888;
const DATA_DIR = path.resolve(__dirname, "../data");

console.log("\x1b[36m\x1b[1m⚡ Starting WarpDM v3.5.0...\x1b[0m");

const engine = new DownloadEngine(DATA_DIR);
const bridge = new BridgeServer(engine, PORT);

await bridge.start();

console.log(`\x1b[32m✔ WarpDM Engine & Bridge Ready!\x1b[0m`);
console.log(`\x1b[1mUI Workspace:\x1b[0m http://127.0.0.1:${PORT}/`);
