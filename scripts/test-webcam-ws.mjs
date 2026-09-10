import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";

const port = 4192;
const baseUrl = `http://127.0.0.1:${port}`;
const socketUrl = `ws://127.0.0.1:${port}`;
const testRoot = mkdtempSync(path.join(os.tmpdir(), "pngcalls-webcam-test-"));
const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: path.join(testRoot, "data"), UPLOAD_DIR: path.join(testRoot, "uploads"), NODE_ENV: "test" };

const initialized = spawnSync(process.execPath, ["scripts/init-db.mjs"], { env, stdio: "inherit" });
assert.equal(initialized.status, 0, "Database initialization failed");
const server = spawn(process.execPath, ["server.mjs"], { env, stdio: ["ignore", "pipe", "inherit"] });

const waitForServer = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Server startup timed out")), 10_000);
  server.stdout.on("data", (chunk) => {
    if (!String(chunk).includes("is ready")) return;
    clearTimeout(timeout);
    resolve();
  });
  server.once("exit", (code) => reject(new Error(`Server exited early with code ${code}`)));
});

const cookiesFrom = (response) => response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
const openSocket = (url, cookie = "") => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { headers: cookie ? { Cookie: cookie } : {} });
  const timeout = setTimeout(() => reject(new Error(`WebSocket connection timed out: ${url}`)), 5_000);
  socket.once("open", () => { clearTimeout(timeout); resolve(socket); });
  socket.once("error", reject);
});

let publisher;
let viewer;
try {
  await waitForServer;
  const setupResponse = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test-host", password: "correct-horse-battery-staple" }),
  });
  assert.equal(setupResponse.status, 201);
  const setup = await setupResponse.json();
  const hostCookies = cookiesFrom(setupResponse);

  const roomResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
    body: JSON.stringify({ name: "WebSocket test" }),
  });
  assert.equal(roomResponse.status, 201);
  const room = await roomResponse.json();

  const joinResponse = await fetch(`${baseUrl}/api/join/${room.sessionId}/${room.joinToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Camera", mediaMode: "webcam" }),
  });
  assert.equal(joinResponse.status, 201);
  const participant = await joinResponse.json();
  const guestCookie = cookiesFrom(joinResponse);

  viewer = await openSocket(`${socketUrl}/ws/view/${room.sessionId}/${room.overlayToken}/${participant.playerId}`);
  publisher = await openSocket(`${socketUrl}/ws/publish/${room.sessionId}/${room.joinToken}/${participant.playerId}`, guestCookie);
  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Viewer did not receive the webcam frame")), 5_000);
    viewer.once("message", (frame) => { clearTimeout(timeout); resolve(frame); });
  });
  const jpeg = Buffer.alloc(128);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[jpeg.length - 2] = 0xff;
  jpeg[jpeg.length - 1] = 0xd9;
  publisher.send(jpeg);
  assert.deepEqual(await received, jpeg);
  console.log("Webcam WebSocket transport passed");
} finally {
  publisher?.terminate();
  viewer?.terminate();
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
