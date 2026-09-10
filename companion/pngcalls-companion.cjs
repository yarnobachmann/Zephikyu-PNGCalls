"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");

const appDir = path.join(process.env.APPDATA || os.homedir(), "Zephikyu PNGCalls");
const configPath = path.join(appDir, "companion.json");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const log = (message) => console.log(`[PNGCalls] ${message}`);

async function configure() {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("Zephikyu PNGCalls Discord Companion\n");
  console.log("First-time setup only. In the PNGCalls host dashboard, open Settings, connect Discord, then create the one-time pairing.");
  const serverUrl = (await prompt.question("PNGCalls address [https://pngcalls.yarnobachmann.nl]: ")).trim() || "https://pngcalls.yarnobachmann.nl";
  const pairingCode = (await prompt.question("Pairing code: ")).trim();
  prompt.close();
  const separator = pairingCode.indexOf(".");
  if (separator < 1 || pairingCode.length < 30) throw new Error("That pairing code is not valid.");
  const config = {
    serverUrl: new URL(serverUrl).origin,
    roomId: pairingCode.slice(0, separator),
    token: pairingCode.slice(separator + 1),
  };
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  return config;
}

function loadConfig() {
  if (process.argv.includes("--configure")) return null;
  try { return JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return null; }
}

class DiscordRpc {
  constructor(clientId, accessToken) {
    this.clientId = clientId;
    this.accessToken = accessToken;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.listeners = new Set();
    this.nonce = 0;
  }

  write(opcode, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(opcode, 0);
    header.writeUInt32LE(body.length, 4);
    this.socket.write(Buffer.concat([header, body]));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (length > 1024 * 1024) return this.socket.destroy(new Error("Discord sent an oversized RPC frame."));
      if (this.buffer.length < 8 + length) return;
      const body = this.buffer.subarray(8, 8 + length);
      this.buffer = this.buffer.subarray(8 + length);
      if (opcode === 3) { this.write(4, JSON.parse(body)); continue; }
      if (opcode === 2) return this.socket.destroy(new Error("Discord closed the RPC connection."));
      if (opcode !== 1) continue;
      const payload = JSON.parse(body);
      if (payload.nonce && this.pending.has(payload.nonce)) {
        const pending = this.pending.get(payload.nonce);
        this.pending.delete(payload.nonce);
        if (payload.evt === "ERROR") pending.reject(new Error(payload.data?.message || "Discord rejected an RPC request."));
        else pending.resolve(payload.data);
      } else {
        for (const listener of this.listeners) listener(payload);
      }
    }
  }

  async connect() {
    for (let index = 0; index < 10; index += 1) {
      try {
        this.socket = await new Promise((resolve, reject) => {
          const socket = net.createConnection(`\\\\?\\pipe\\discord-ipc-${index}`);
          const timeout = setTimeout(() => socket.destroy(new Error("Discord RPC connection timed out.")), 1200);
          socket.once("connect", () => { clearTimeout(timeout); resolve(socket); });
          socket.once("error", reject);
        });
        break;
      } catch {
        this.socket = null;
      }
    }
    if (!this.socket) throw new Error("Discord Desktop is not running. Start Discord and try again.");
    this.socket.on("data", (chunk) => {
      try { this.handleData(chunk); } catch (error) { this.socket.destroy(error); }
    });
    this.socket.on("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Discord RPC disconnected."));
      this.pending.clear();
    });
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.listeners.delete(onReady); reject(new Error("Discord RPC handshake timed out.")); }, 7000);
      const onReady = (event) => {
        if (event.evt !== "READY") return;
        clearTimeout(timeout);
        this.listeners.delete(onReady);
        resolve();
      };
      this.listeners.add(onReady);
    });
    this.write(0, { v: 1, client_id: this.clientId });
    await ready;
    await this.request("AUTHENTICATE", { access_token: this.accessToken });
    return this;
  }

  request(cmd, args = {}, evt) {
    const nonce = `pngcalls-${Date.now()}-${this.nonce += 1}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(nonce); reject(new Error(`${cmd} timed out.`)); }, 7000);
      this.pending.set(nonce, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.write(1, { cmd, args, nonce, ...(evt ? { evt } : {}) });
    });
  }
}

async function runDiscord(clientId, accessToken, send, serverClosed) {
  const rpc = await new DiscordRpc(clientId, accessToken).connect();
  log("Connected to Discord Desktop.");
  let channel = null;
  let subscribedChannelId = null;
  const speaking = new Set();

  const publish = () => {
    const states = Array.isArray(channel?.voice_states) ? channel.voice_states : [];
    send({
      type: "snapshot",
      channel: channel ? { id: String(channel.id), name: channel.name || (channel.type === 1 ? "Direct call" : "Discord call"), type: Number(channel.type) } : null,
      users: states.map((entry) => ({
        id: String(entry.user?.id || ""),
        name: entry.nick || entry.user?.global_name || entry.user?.username || "Discord user",
        username: entry.user?.username || "Discord user",
        bot: Boolean(entry.user?.bot),
        muted: Boolean(entry.mute || entry.voice_state?.mute || entry.voice_state?.self_mute),
        speaking: speaking.has(String(entry.user?.id || "")),
      })),
    });
  };

  const subscribe = async (channelId) => {
    if (!channelId || channelId === subscribedChannelId) return;
    subscribedChannelId = channelId;
    for (const event of ["SPEAKING_START", "SPEAKING_STOP", "VOICE_STATE_CREATE", "VOICE_STATE_UPDATE", "VOICE_STATE_DELETE"]) {
      await rpc.request("SUBSCRIBE", { channel_id: channelId }, event).catch((error) => log(`${event}: ${error.message}`));
    }
  };

  const refresh = async () => {
    channel = await rpc.request("GET_SELECTED_VOICE_CHANNEL").catch(() => null);
    await subscribe(channel?.id ? String(channel.id) : null);
    publish();
  };

  rpc.listeners.add((event) => {
    const userId = String(event.data?.user_id || "");
    if (event.evt === "SPEAKING_START" && userId) speaking.add(userId);
    if (event.evt === "SPEAKING_STOP" && userId) speaking.delete(userId);
    if (["VOICE_STATE_CREATE", "VOICE_STATE_UPDATE", "VOICE_STATE_DELETE", "VOICE_CHANNEL_SELECT"].includes(event.evt)) refresh().catch((error) => log(error.message));
    else if (event.evt === "SPEAKING_START" || event.evt === "SPEAKING_STOP") publish();
  });

  await refresh();
  const poll = setInterval(() => refresh().catch((error) => log(error.message)), 3000);
  const reason = await Promise.race([
    new Promise((resolve) => rpc.socket.once("close", () => resolve("Discord Desktop disconnected."))),
    serverClosed.then(() => "PNGCalls server disconnected."),
  ]);
  clearInterval(poll);
  if (!rpc.socket.destroyed) rpc.socket.destroy();
  throw new Error(reason);
}

async function connect(config) {
  const endpoint = new URL(config.serverUrl);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  endpoint.pathname = "/ws/discord";
  log(`Connecting to ${endpoint.origin}`);
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("PNGCalls connection timed out.")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Could not connect to PNGCalls.")); }, { once: true });
  });
  const serverClosed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "pair", roomId: config.roomId, token: config.token }));
  const credentials = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("PNGCalls did not accept the pairing code.")), 10_000);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "credentials") { clearTimeout(timeout); resolve(message); }
      if (message.type === "error") { clearTimeout(timeout); reject(new Error(message.message)); }
    });
    socket.addEventListener("close", (event) => { clearTimeout(timeout); reject(new Error(event.reason || "PNGCalls closed the connection.")); }, { once: true });
  });
  log("Paired with PNGCalls.");
  const send = (payload) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); };
  const heartbeat = setInterval(() => send({ type: "heartbeat" }), 5000);
  try { await runDiscord(credentials.clientId, credentials.accessToken, send, serverClosed); }
  finally { clearInterval(heartbeat); socket.close(); }
}

async function main() {
  let config = loadConfig();
  if (!config) config = await configure();
  log("Setup is saved. Future launches reconnect automatically, including when started with OBS.");
  while (true) {
    try { await connect(config); }
    catch (error) { log(error.message); }
    log("Retrying in 5 seconds. Press Ctrl+C to stop.");
    await delay(5000);
  }
}

main().catch((error) => {
  console.error(`\nPNGCalls companion could not start: ${error.message}`);
  console.log("Run PNGCalls-Companion.exe --configure to enter a new pairing code.");
  process.stdin.resume();
});
