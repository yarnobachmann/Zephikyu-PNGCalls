import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";

const port = 4192;
const baseUrl = `http://127.0.0.1:${port}`;
const socketUrl = `ws://127.0.0.1:${port}`;
const testRoot = mkdtempSync(path.join(os.tmpdir(), "pngcalls-webcam-test-"));
const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: path.join(testRoot, "data"), UPLOAD_DIR: path.join(testRoot, "uploads"), NODE_ENV: "test", DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "", DISCORD_REDIRECT_URI: "" };

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

  const discordSecret = "test-discord-secret-value-123456";
  const discordConfigResponse = await fetch(`${baseUrl}/api/discord/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
    body: JSON.stringify({ clientId: "123456789012345678", clientSecret: discordSecret }),
  });
  assert.equal(discordConfigResponse.status, 200);
  const discordStatusResponse = await fetch(`${baseUrl}/api/discord/status`, { headers: { Cookie: hostCookies } });
  assert.equal(discordStatusResponse.status, 200);
  const discordStatus = await discordStatusResponse.json();
  assert.equal(discordStatus.configured, true);
  assert.equal(discordStatus.clientId, "123456789012345678");
  assert.equal(discordStatus.source, "settings");
  assert.equal(JSON.stringify(discordStatus).includes(discordSecret), false);
  assert.equal(existsSync(path.join(testRoot, "data", ".credentials-key")), true);
  const database = new DatabaseSync(path.join(testRoot, "data", "zephikyu.db"), { readOnly: true });
  const storedConfig = database.prepare('SELECT "clientSecretEncrypted" FROM "DiscordOAuthConfig" WHERE "id" = 1').get();
  database.close();
  assert.notEqual(storedConfig.clientSecretEncrypted, discordSecret);
  assert.equal(storedConfig.clientSecretEncrypted.includes(discordSecret), false);

  const removeDiscordResponse = await fetch(`${baseUrl}/api/discord/config`, {
    method: "DELETE",
    headers: { Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
  });
  assert.equal(removeDiscordResponse.status, 204);
  const removedDiscordStatus = await fetch(`${baseUrl}/api/discord/status`, { headers: { Cookie: hostCookies } }).then((response) => response.json());
  assert.equal(removedDiscordStatus.configured, false);

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
    body: JSON.stringify({ name: "Camera", mediaMode: "webcam", nameFont: "typewriter" }),
  });
  assert.equal(joinResponse.status, 201);
  const participant = await joinResponse.json();
  const guestCookie = cookiesFrom(joinResponse);
  assert.equal(participant.player.nameFont, "typewriter");
  const overlay = await fetch(`${baseUrl}/api/overlay/${room.sessionId}/${room.overlayToken}`).then((response) => response.json());
  assert.equal(overlay.players[0].nameFont, "typewriter");

  const placementResponse = await fetch(`${baseUrl}/api/sessions/${room.sessionId}/placements`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
    body: JSON.stringify({ players: [{ id: participant.playerId, x: 21, y: 64, size: 1.4, layer: 3 }] }),
  });
  assert.equal(placementResponse.status, 200);
  const placedRoom = await placementResponse.json();
  assert.equal(placedRoom.players[0].positionX, 21);
  assert.equal(placedRoom.players[0].positionY, 64);
  assert.equal(placedRoom.players[0].displaySize, 1.4);
  assert.equal(placedRoom.players[0].displayLayer, 3);
  const placedOverlay = await fetch(`${baseUrl}/api/overlay/${room.sessionId}/${room.overlayToken}`).then((response) => response.json());
  assert.equal(placedOverlay.players[0].positionX, 21);
  assert.equal(placedOverlay.players[0].positionY, 64);
  assert.equal(placedOverlay.players[0].displaySize, 1.4);

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

  const resetResponse = await fetch(`${baseUrl}/api/sessions/${room.sessionId}/reset-join`, {
    method: "POST",
    headers: { Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
  });
  assert.equal(resetResponse.status, 200);
  const resetRoom = await resetResponse.json();
  assert.equal(resetRoom.overlayToken, room.overlayToken);
  assert.notEqual(resetRoom.joinToken, room.joinToken);
  assert.equal(resetRoom.players.length, 0);
  const oldInviteResponse = await fetch(`${baseUrl}/api/join/${room.sessionId}/${room.joinToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Old link" }),
  });
  assert.equal(oldInviteResponse.status, 401);
  const unchangedOverlay = await fetch(`${baseUrl}/api/overlay/${room.sessionId}/${room.overlayToken}`);
  assert.equal(unchangedOverlay.status, 200);
  console.log("Discord settings, webcam transport, guest fonts, placement, and invite reset passed");
} finally {
  publisher?.terminate();
  viewer?.terminate();
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
