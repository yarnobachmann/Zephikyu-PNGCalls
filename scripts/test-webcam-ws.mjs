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
const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: path.join(testRoot, "data"), UPLOAD_DIR: path.join(testRoot, "uploads"), NODE_ENV: "test", DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "", DISCORD_REDIRECT_URI: "", DISCORD_TEST_ACCESS_TOKEN: "test-rpc-access-token", DISCORD_TEST_USER_ID: "111122223333444455" };

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
let companion;
let activity;
try {
  await waitForServer;
  const setupResponse = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test-host", password: "correct-horse-battery-staple" }),
  });
  assert.equal(setupResponse.status, 201);
  const setup = await setupResponse.json();
  const issuedCookies = setupResponse.headers.getSetCookie();
  assert.match(issuedCookies.find((cookie) => cookie.startsWith("zephikyu_host=")), /SameSite=Lax/);
  assert.match(issuedCookies.find((cookie) => cookie.startsWith("zephikyu_csrf=")), /SameSite=Strict/);
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
  assert.equal(discordStatus.activityUrl, "https://discord.com/activities/123456789012345678");
  assert.equal(JSON.stringify(discordStatus).includes(discordSecret), false);
  const activityConfig = await fetch(`${baseUrl}/api/discord/activity/config`).then((response) => response.json());
  assert.deepEqual(activityConfig, { enabled: true, clientId: "123456789012345678" });
  const activityPage = await fetch(`${baseUrl}/?frame_id=test-frame&instance_id=test-instance&platform=desktop`);
  assert.equal(activityPage.status, 200);
  assert.match(activityPage.headers.get("content-security-policy"), /frame-ancestors https:\/\/discord\.com/);
  assert.match(await activityPage.text(), /Discord Call Connector/i);
  assert.equal(existsSync(path.join(testRoot, "data", ".credentials-key")), true);
  const oauthStart = await fetch(`${baseUrl}/auth/discord`, { headers: { Cookie: hostCookies }, redirect: "manual" });
  assert.equal(oauthStart.status, 302);
  const oauthLocation = new URL(oauthStart.headers.get("location"));
  const oauthState = oauthLocation.searchParams.get("state");
  const oauthCookie = oauthStart.headers.getSetCookie().find((cookie) => cookie.startsWith("zephikyu_discord_oauth="));
  assert.match(oauthCookie, /HttpOnly/);
  assert.match(oauthCookie, /SameSite=Lax/);
  assert.equal(decodeURIComponent(oauthCookie.split(";", 1)[0].split("=", 2)[1]), oauthState);
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

  const companionConfigResponse = await fetch(`${baseUrl}/api/discord/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
    body: JSON.stringify({ clientId: "123456789012345678", clientSecret: discordSecret }),
  });
  assert.equal(companionConfigResponse.status, 200);
  const companionDatabase = new DatabaseSync(path.join(testRoot, "data", "zephikyu.db"));
  companionDatabase.prepare('INSERT INTO "DiscordConnection" ("id", "discordUserId", "username", "accessTokenEncrypted", "scopes", "connectedAt") VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run("111122223333444455", "Host", "test", "identify rpc rpc.voice.read");
  companionDatabase.close();
  const pairResponse = await fetch(`${baseUrl}/api/sessions/${room.sessionId}/discord-companion/pair`, {
    method: "POST",
    headers: { Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
  });
  assert.equal(pairResponse.status, 200);
  const pairing = await pairResponse.json();
  const [pairedRoomId, pairingToken] = pairing.pairingCode.split(".", 2);
  assert.equal(pairedRoomId, room.sessionId);
  companion = await openSocket(`${socketUrl}/ws/discord`);
  const companionCredentials = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Companion did not receive credentials")), 5_000);
    companion.once("message", (message) => { clearTimeout(timeout); resolve(JSON.parse(String(message))); });
  });
  companion.send(JSON.stringify({ type: "pair", roomId: room.sessionId, token: pairingToken }));
  const credentials = await companionCredentials;
  assert.equal(credentials.type, "credentials");
  assert.equal(credentials.clientId, "123456789012345678");
  assert.equal(credentials.accessToken, "test-rpc-access-token");
  companion.send(JSON.stringify({ type: "snapshot", channel: { id: "777788889999000011", name: "Direct call", type: 1 }, users: [{ id: "222233334444555566", name: "Discord friend", speaking: true, muted: false }] }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const companionOverlay = await fetch(`${baseUrl}/api/overlay/${room.sessionId}/${room.overlayToken}`).then((response) => response.json());
  const discordPlayer = companionOverlay.players.find((player) => player.source === "discord");
  assert.equal(discordPlayer.name, "Discord friend");
  assert.equal(discordPlayer.speaking, true);
  assert.equal(companionOverlay.companion.channelName, "Direct call");

  const activityTokenResponse = await fetch(`${baseUrl}/api/discord/activity/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "test-activity-code" }),
  });
  assert.equal(activityTokenResponse.status, 200);
  const activityCredentials = await activityTokenResponse.json();
  assert.equal(activityCredentials.access_token, "test-activity-access-token");
  assert.equal(activityCredentials.rooms.some((entry) => entry.id === room.sessionId), true);
  activity = await openSocket(`${socketUrl}/ws/activity/${room.sessionId}/${activityCredentials.bridge_token}`);
  const activityAck = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Activity snapshot was not acknowledged")), 5_000);
    activity.once("message", (message) => { clearTimeout(timeout); resolve(JSON.parse(String(message))); });
  });
  activity.send(JSON.stringify({ type: "snapshot", channel: { id: "777788889999000011", name: "Activity direct call" }, users: [{ id: "222233334444555566", name: "Discord friend", avatar: "abc123", speaking: false, muted: false }] }));
  assert.deepEqual(await activityAck, { type: "snapshot_ack", count: 1, roomName: "WebSocket test" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const activityOverlay = await fetch(`${baseUrl}/api/overlay/${room.sessionId}/${room.overlayToken}`).then((response) => response.json());
  assert.equal(activityOverlay.players.find((player) => player.source === "discord").speaking, false);
  assert.equal(activityOverlay.players.find((player) => player.source === "discord").discordAvatar, "https://cdn.discordapp.com/avatars/222233334444555566/abc123.webp?size=512");
  assert.equal(activityOverlay.players.find((player) => player.source === "discord").useDiscordAvatar, true);
  assert.equal(activityOverlay.companion.channelName, "Activity direct call");
  assert.equal(activityOverlay.companion.mode, "activity");
  const styledDiscordPlayer = activityOverlay.players.find((player) => player.source === "discord");
  const styleResponse = await fetch(`${baseUrl}/api/sessions/${room.sessionId}/players/${styledDiscordPlayer.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
    body: JSON.stringify({ name: styledDiscordPlayer.name, nameFont: "comic", nameBackground: "none", nameBackgroundColor: "#123456", nameOffsetX: 14, nameOffsetY: -32, useDiscordAvatar: true }),
  });
  assert.equal(styleResponse.status, 200);
  const styledOverlay = await fetch(`${baseUrl}/api/overlay/${room.sessionId}/${room.overlayToken}`).then((response) => response.json());
  assert.equal(styledOverlay.players.find((player) => player.id === styledDiscordPlayer.id).nameFont, "comic");
  assert.equal(styledOverlay.players.find((player) => player.id === styledDiscordPlayer.id).nameBackground, "none");
  assert.equal(styledOverlay.players.find((player) => player.id === styledDiscordPlayer.id).nameOffsetX, 14);
  assert.equal(styledOverlay.players.find((player) => player.id === styledDiscordPlayer.id).nameOffsetY, -32);
  await new Promise((resolve) => setTimeout(resolve, 7250));
  const silentActivityOverlay = await fetch(`${baseUrl}/api/overlay/${room.sessionId}/${room.overlayToken}`).then((response) => response.json());
  assert.equal(silentActivityOverlay.players.some((player) => player.id === styledDiscordPlayer.id), true, "Silent Discord users must remain visible while the Activity is connected");

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
  assert.equal(overlay.players.find((player) => player.id === participant.playerId).nameFont, "typewriter");

  const placementResponse = await fetch(`${baseUrl}/api/sessions/${room.sessionId}/placements`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
    body: JSON.stringify({ players: [{ id: participant.playerId, x: 21, y: 64, size: 1.4, layer: 3, nameSize: 1.65, nameX: -8, nameY: 12 }] }),
  });
  assert.equal(placementResponse.status, 200);
  const placedRoom = await placementResponse.json();
  const placedPlayer = placedRoom.players.find((player) => player.id === participant.playerId);
  assert.equal(placedPlayer.positionX, 21);
  assert.equal(placedPlayer.positionY, 64);
  assert.equal(placedPlayer.displaySize, 1.4);
  assert.equal(placedPlayer.displayLayer, 3);
  assert.equal(placedPlayer.nameSize, 1.65);
  assert.equal(placedPlayer.nameOffsetX, -8);
  assert.equal(placedPlayer.nameOffsetY, 12);
  const placedOverlay = await fetch(`${baseUrl}/api/overlay/${room.sessionId}/${room.overlayToken}`).then((response) => response.json());
  const placedOverlayPlayer = placedOverlay.players.find((player) => player.id === participant.playerId);
  assert.equal(placedOverlayPlayer.positionX, 21);
  assert.equal(placedOverlayPlayer.positionY, 64);
  assert.equal(placedOverlayPlayer.displaySize, 1.4);
  assert.equal(placedOverlayPlayer.nameSize, 1.65);
  assert.equal(placedOverlayPlayer.nameOffsetX, -8);
  assert.equal(placedOverlayPlayer.nameOffsetY, 12);

  const automaticResetResponse = await fetch(`${baseUrl}/api/sessions/${room.sessionId}/placements`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
    body: JSON.stringify({ reset: true }),
  });
  assert.equal(automaticResetResponse.status, 200);
  const stackLayoutResponse = await fetch(`${baseUrl}/api/sessions/${room.sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: hostCookies, "X-CSRF-Token": setup.csrfToken },
    body: JSON.stringify({ layout: "stack" }),
  });
  assert.equal(stackLayoutResponse.status, 200);
  const automaticOverlay = await fetch(`${baseUrl}/api/overlay/${room.sessionId}/${room.overlayToken}`).then((response) => response.json());
  assert.equal(automaticOverlay.layout, "stack");
  assert.equal(automaticOverlay.players.find((player) => player.id === participant.playerId).positionX, null);
  assert.equal(automaticOverlay.players.find((player) => player.id === participant.playerId).displaySize, 1);

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
  assert.equal(resetRoom.players.some((player) => player.id === participant.playerId), false);
  assert.equal(resetRoom.players.some((player) => player.source === "discord"), true);
  const oldInviteResponse = await fetch(`${baseUrl}/api/join/${room.sessionId}/${room.joinToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Old link" }),
  });
  assert.equal(oldInviteResponse.status, 401);
  const unchangedOverlay = await fetch(`${baseUrl}/api/overlay/${room.sessionId}/${room.overlayToken}`);
  assert.equal(unchangedOverlay.status, 200);
  console.log("Discord companion, webcam transport, guest fonts, placement, and invite reset passed");
} finally {
  publisher?.terminate();
  viewer?.terminate();
  companion?.terminate();
  activity?.terminate();
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
