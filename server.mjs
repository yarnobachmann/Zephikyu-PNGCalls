import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import { PrismaClient } from "@prisma/client";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
const stateFile = path.join(dataDir, "state.json");
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 8) * 1024 * 1024;
process.env.DATABASE_URL = `file:${path.join(dataDir, "zephikyu.db").replaceAll("\\", "/")}`;
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const prisma = new PrismaClient();
const app = express();
const clients = new Map();
const discordStates = new Map();
const auditSalt = crypto.randomBytes(32);
const allowedImages = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"]]);
const speakingAnimations = new Set(["none", "bounce", "pulse", "shake", "glow"]);
const speakingAnimation = (value) => speakingAnimations.has(value) ? value : "none";

const token = (bytes = 18) => crypto.randomBytes(bytes).toString("base64url");
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const cleanId = (value, fallback = "player") => String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
const cleanText = (value, fallback, max) => String(value || fallback).trim().slice(0, max);
const bearer = (req) => String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
const guestCookieName = (roomId) => `zephikyu_guest_${cleanId(roomId)}`;
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 1 ? [part, ""] : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

const cookieSecure = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
function setCookie(res, name, value, maxAge, secure, httpOnly = true) {
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; SameSite=Strict; Path=/; Max-Age=${maxAge}${httpOnly ? "; HttpOnly" : ""}${secure ? "; Secure" : ""}`);
}
const ipHash = (req) => crypto.createHmac("sha256", auditSalt).update(String(req.ip || "unknown")).digest("hex").slice(0, 24);
async function audit(req, action, outcome, target = null, actor = "host") {
  await prisma.auditEvent.create({ data: { action, outcome, actor, target, ipHash: ipHash(req) } }).catch((error) => console.error("Audit write failed", error));
}

async function getHostContext(req) {
  const raw = parseCookies(req).zephikyu_host;
  if (!raw) return null;
  const authSession = await prisma.hostSession.findUnique({ where: { id: hash(raw) } });
  if (!authSession || authSession.expiresAt <= new Date()) {
    if (authSession) await prisma.hostSession.delete({ where: { id: authSession.id } }).catch(() => {});
    return null;
  }
  const owner = await prisma.owner.findUnique({ where: { id: 1 } });
  return owner ? { owner, authSession } : null;
}

async function requireHost(req, res, next) {
  const context = await getHostContext(req);
  if (!context) return res.status(401).json({ error: "Host login required" });
  req.hostContext = context;
  next();
}

function requireCsrf(req, res, next) {
  const csrfCookie = parseCookies(req).zephikyu_csrf || "";
  const csrfHeader = String(req.headers["x-csrf-token"] || "");
  if (!csrfCookie || !csrfHeader || !safeEqual(csrfCookie, csrfHeader) || !safeEqual(hash(csrfCookie), req.hostContext.authSession.csrfHash)) {
    return res.status(403).json({ error: "Security token expired. Refresh and try again." });
  }
  next();
}

async function issueHostSession(req, res) {
  const raw = token(32);
  const csrf = token(24);
  const maxAge = 60 * 60 * 12;
  await prisma.hostSession.create({ data: {
    id: hash(raw), csrfHash: hash(csrf), expiresAt: new Date(Date.now() + maxAge * 1000), ipHash: ipHash(req), userAgent: String(req.headers["user-agent"] || "").slice(0, 250),
  } });
  const secure = cookieSecure(req);
  setCookie(res, "zephikyu_host", raw, maxAge, secure, true);
  setCookie(res, "zephikyu_csrf", csrf, maxAge, secure, false);
  return csrf;
}

async function getRoom(req, res) {
  const room = await prisma.room.findUnique({ where: { id: req.params.sessionId }, include: { players: { include: { presence: true } } } });
  if (!room) res.status(404).json({ error: "Room not found" });
  return room;
}

function publicRoom(room) {
  const cutoff = Date.now() - 7000;
  const active = room.players.filter((player) => player.presence?.present !== false && player.presence?.lastSeen?.getTime() >= cutoff);
  const activeIds = new Set(active.map((player) => player.id));
  return {
    id: room.id, name: room.name, layout: room.layout, background: room.background,
    players: room.players.filter((player) => activeIds.has(player.id) || (player.pinned && player.presence?.source !== "browser")).map((player) => ({
      id: player.id, name: player.name, idleImage: player.idleImage, talkingImage: player.talkingImage || player.idleImage, accent: player.accent,
      mediaMode: player.mediaMode || "png",
      speakingAnimation: speakingAnimation(player.speakingAnimation),
      webcamImage: player.mediaMode === "webcam" ? `/api/webcam/${room.id}/${room.overlayToken}/${player.id}` : null,
      speaking: Boolean(player.presence?.speaking), muted: Boolean(player.presence?.muted), source: player.presence?.source || "manual",
    })),
    onlineCount: active.length, updatedAt: room.updatedAt.getTime(),
  };
}

async function roomPayload(roomId) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, include: { players: { include: { presence: true } } } });
  return room ? publicRoom(room) : null;
}
async function broadcast(roomId) {
  const payload = await roomPayload(roomId);
  if (!payload) return;
  for (const response of clients.get(roomId) || []) response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function removeUploadedFile(url) {
  if (!url || !String(url).startsWith("/uploads/")) return;
  try { fs.unlinkSync(path.join(uploadDir, path.basename(String(url)))); }
  catch (error) { if (error?.code !== "ENOENT") console.error("Could not remove uploaded file", error); }
}

const webcamFile = (roomId, playerId) => path.join(uploadDir, `webcam-${cleanId(roomId)}-${cleanId(playerId)}.jpg`);
function removeWebcamFile(roomId, playerId) {
  try { fs.unlinkSync(webcamFile(roomId, playerId)); }
  catch (error) { if (error?.code !== "ENOENT") console.error("Could not remove webcam frame", error); }
}

async function validateUploadedImages(files) {
  const uploaded = Object.values(files || {}).flat();
  try {
    for (const file of uploaded) {
      const detected = await fileTypeFromFile(file.path);
      if (!detected || !allowedImages.has(detected.mime)) throw new Error("Uploaded content is not a valid PNG, JPG, WebP, or GIF image");
      const expected = allowedImages.get(detected.mime);
      const actual = path.extname(file.filename).slice(1).toLowerCase();
      if ((actual === "jpeg" ? "jpg" : actual) !== expected) throw new Error("Image extension does not match its content");
    }
  } catch (error) {
    for (const file of uploaded) removeUploadedFile(`/uploads/${file.filename}`);
    throw error;
  }
}

async function importLegacyState() {
  if ((await prisma.room.count()) || (await prisma.owner.count()) || !fs.existsSync(stateFile)) return;
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return; }
  await prisma.$transaction(async (tx) => {
    if (legacy.owner) await tx.owner.create({ data: {
      id: 1, username: String(legacy.owner.username), salt: String(legacy.owner.salt), passwordHash: String(legacy.owner.passwordHash), createdAt: new Date(legacy.owner.createdAt || Date.now()),
    } });
    for (const room of Object.values(legacy.sessions || {})) {
      await tx.room.create({ data: {
        id: room.id, name: room.name || "My PNGCalls crew", overlayToken: room.overlayToken || token(), joinToken: room.joinToken || token(),
        layout: room.layout || "row", background: room.background || "transparent", createdAt: new Date(room.createdAt || Date.now()), updatedAt: new Date(room.updatedAt || Date.now()),
      } });
      for (const player of Object.values(room.players || {})) {
        const presence = room.presence?.[player.id];
        await tx.player.create({ data: {
          id: player.id, roomId: room.id, name: player.name || player.id, accent: player.accent || "#d0193c", pinned: Boolean(player.pinned),
          joinKey: player.joinKey || null, idleImage: player.idleImage || null, talkingImage: player.talkingImage || null, mediaMode: player.mediaMode || "png", speakingAnimation: speakingAnimation(player.speakingAnimation),
          presence: presence ? { create: { present: presence.present !== false, speaking: Boolean(presence.speaking), muted: Boolean(presence.muted), source: presence.source || "manual", lastSeen: new Date(presence.lastSeen || Date.now()) } } : undefined,
        } });
      }
    }
  });
  console.log("Imported existing JSON data into SQLite");
}

const storage = multer.diskStorage({
  destination: (_req, _file, done) => done(null, uploadDir),
  filename: (req, file, done) => done(null, `${cleanId(req.params.sessionId)}-${cleanId(req.params.playerId)}-${file.fieldname}-${token(7)}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage, limits: { fileSize: maxUploadBytes, files: 2, fields: 4 },
  fileFilter: (_req, file, done) => { const allowed = allowedImages.has(file.mimetype); done(allowed ? null : new Error("Use PNG, JPG, WebP, or GIF images"), allowed); },
});
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
const joinLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
const heartbeatLimit = rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: "draft-8", legacyHeaders: false });
const webcamLimit = rateLimit({ windowMs: 60 * 1000, limit: 1200, standardHeaders: "draft-8", legacyHeaders: false });

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "blob:"],
  connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
} }, crossOriginResourcePolicy: { policy: "same-origin" } }));
app.use(express.json({ limit: "256kb", type: "application/json" }));
app.use((_req, res, next) => { res.set("Permissions-Policy", "microphone=(self), camera=(self)"); next(); });
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
app.use("/uploads", express.static(uploadDir, { fallthrough: false, maxAge: "1h", dotfiles: "deny" }));

app.get("/api/health", async (_req, res) => { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true, database: "sqlite" }); });
app.get("/api/auth/status", async (req, res) => {
  const owner = await prisma.owner.findUnique({ where: { id: 1 }, select: { username: true } });
  const context = await getHostContext(req);
  const csrf = parseCookies(req).zephikyu_csrf || "";
  const validCsrf = context && safeEqual(hash(csrf), context.authSession.csrfHash);
  res.json({ needsSetup: !owner, authenticated: Boolean(context), username: context?.owner.username || null, csrfToken: validCsrf ? csrf : null });
});
app.post("/api/auth/setup", authLimit, async (req, res) => {
  if (await prisma.owner.count()) return res.status(409).json({ error: "Host account already exists" });
  const username = cleanText(req.body?.username, "", 60);
  const password = String(req.body?.password || "");
  if (username.length < 2) return res.status(400).json({ error: "Username must be at least 2 characters" });
  if (password.length < 12) return res.status(400).json({ error: "Password must be at least 12 characters" });
  const salt = crypto.randomBytes(16).toString("hex");
  await prisma.owner.create({ data: { id: 1, username, salt, passwordHash: crypto.scryptSync(password, salt, 64).toString("hex") } });
  const csrfToken = await issueHostSession(req, res);
  await audit(req, "owner.setup", "success", username);
  res.status(201).json({ authenticated: true, username, csrfToken });
});
app.post("/api/auth/login", authLimit, async (req, res) => {
  const owner = await prisma.owner.findUnique({ where: { id: 1 } });
  const username = cleanText(req.body?.username, "", 60);
  const password = String(req.body?.password || "");
  let valid = false;
  if (owner) {
    const supplied = crypto.scryptSync(password, owner.salt, 64);
    const expected = Buffer.from(owner.passwordHash, "hex");
    valid = safeEqual(username, owner.username) && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  } else crypto.scryptSync(password, crypto.randomBytes(16), 64);
  if (!valid) { await audit(req, "owner.login", "failure", null, "anonymous"); return res.status(401).json({ error: "Incorrect username or password" }); }
  await prisma.hostSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const csrfToken = await issueHostSession(req, res);
  await audit(req, "owner.login", "success", owner.username);
  res.json({ authenticated: true, username: owner.username, csrfToken });
});
app.post("/api/auth/logout", requireHost, requireCsrf, async (req, res) => {
  await prisma.hostSession.delete({ where: { id: req.hostContext.authSession.id } }).catch(() => {});
  await audit(req, "owner.logout", "success");
  const secure = cookieSecure(req);
  setCookie(res, "zephikyu_host", "", 0, secure, true); setCookie(res, "zephikyu_csrf", "", 0, secure, false);
  res.status(204).end();
});

app.get("/api/discord/status", requireHost, async (_req, res) => {
  const connection = await prisma.discordConnection.findUnique({ where: { id: 1 } });
  res.json({
    configured: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
    connected: connection ? { username: connection.username, connectedAt: connection.connectedAt } : null,
  });
});

app.get("/auth/discord", requireHost, async (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId || !process.env.DISCORD_CLIENT_SECRET) return res.status(503).send("Discord OAuth is not configured on this server.");
  const state = token(32);
  discordStates.set(hash(state), { hostSessionId: req.hostContext.authSession.id, expiresAt: Date.now() + 10 * 60 * 1000 });
  const callback = process.env.DISCORD_REDIRECT_URI || `${process.env.PUBLIC_URL || `http://localhost:${port}`}/auth/discord/callback`;
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.search = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: callback, scope: "identify", state, prompt: "consent" }).toString();
  res.redirect(authorize.toString());
});

app.get("/auth/discord/callback", async (req, res) => {
  const context = await getHostContext(req);
  const stateKey = hash(String(req.query.state || ""));
  const pending = discordStates.get(stateKey);
  discordStates.delete(stateKey);
  if (!context || !pending || pending.expiresAt < Date.now() || pending.hostSessionId !== context.authSession.id || !req.query.code) {
    return res.status(400).send("Discord connection could not be verified. Return to PNGCalls and try again.");
  }
  const callback = process.env.DISCORD_REDIRECT_URI || `${process.env.PUBLIC_URL || `http://localhost:${port}`}/auth/discord/callback`;
  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code: String(req.query.code), redirect_uri: callback }),
  });
  if (!tokenResponse.ok) return res.status(502).send("Discord rejected the connection request.");
  const credentials = await tokenResponse.json();
  const userResponse = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${credentials.access_token}` } });
  if (!userResponse.ok) return res.status(502).send("Discord profile lookup failed.");
  const user = await userResponse.json();
  const username = cleanText(user.global_name || user.username, "Discord user", 80);
  await prisma.discordConnection.upsert({ where: { id: 1 }, create: { id: 1, discordUserId: String(user.id), username }, update: { discordUserId: String(user.id), username, connectedAt: new Date() } });
  await audit(req, "discord.connect", "success", String(user.id));
  res.redirect("/?discord=connected");
});

app.post("/api/discord/disconnect", requireHost, requireCsrf, async (req, res) => {
  await prisma.discordConnection.deleteMany();
  await audit(req, "discord.disconnect", "success");
  res.status(204).end();
});

app.get("/api/sessions", requireHost, async (_req, res) => {
  const rooms = await prisma.room.findMany({ orderBy: { updatedAt: "desc" }, select: { id: true, name: true, updatedAt: true } });
  res.json(rooms.map((room) => ({ ...room, updatedAt: room.updatedAt.getTime() })));
});
app.post("/api/sessions", requireHost, requireCsrf, async (req, res) => {
  const room = await prisma.room.create({ data: { id: token(8), name: cleanText(req.body?.name, "My PNGCalls crew", 80), overlayToken: token(), joinToken: token() } });
  await audit(req, "room.create", "success", room.id);
  res.status(201).json({ sessionId: room.id, joinToken: room.joinToken, overlayToken: room.overlayToken });
});
app.get("/api/sessions/:sessionId", requireHost, async (req, res) => {
  const room = await getRoom(req, res); if (room) res.json({ ...publicRoom(room), joinToken: room.joinToken, overlayToken: room.overlayToken });
});
app.patch("/api/sessions/:sessionId", requireHost, requireCsrf, async (req, res) => {
  const current = await getRoom(req, res); if (!current) return;
  const data = {};
  if (typeof req.body?.name === "string") data.name = cleanText(req.body.name, current.name, 80);
  if (["row", "stack", "arc"].includes(req.body?.layout)) data.layout = req.body.layout;
  if (["transparent", "checker", "dark"].includes(req.body?.background)) data.background = req.body.background;
  await prisma.room.update({ where: { id: current.id }, data });
  await audit(req, "room.update", "success", current.id); await broadcast(current.id);
  res.json(await roomPayload(current.id));
});
app.put("/api/sessions/:sessionId/players/:playerId", requireHost, requireCsrf, async (req, res) => {
  const room = await getRoom(req, res); if (!room) return;
  const id = cleanId(req.params.playerId);
  const current = room.players.find((player) => player.id === id);
  const conflicting = await prisma.player.findUnique({ where: { id }, select: { roomId: true } });
  if (conflicting && conflicting.roomId !== room.id) return res.status(409).json({ error: "Player ID already exists" });
  const player = await prisma.player.upsert({ where: { id }, create: {
    id, roomId: room.id, name: cleanText(req.body?.name, id, 60), accent: /^#[0-9a-f]{6}$/i.test(req.body?.accent) ? req.body.accent : "#d0193c",
    pinned: req.body?.pinned === undefined ? true : Boolean(req.body.pinned), mediaMode: "png", speakingAnimation: speakingAnimation(req.body?.speakingAnimation), presence: { create: { source: "manual" } },
  }, update: {
    name: cleanText(req.body?.name, current?.name || id, 60), accent: /^#[0-9a-f]{6}$/i.test(req.body?.accent) ? req.body.accent : current?.accent || "#d0193c",
    pinned: req.body?.pinned === undefined ? current?.pinned ?? true : Boolean(req.body.pinned), speakingAnimation: req.body?.speakingAnimation === undefined ? speakingAnimation(current?.speakingAnimation) : speakingAnimation(req.body.speakingAnimation),
  } });
  await prisma.room.update({ where: { id: room.id }, data: { updatedAt: new Date() } }); await broadcast(room.id); res.json(player);
});

async function hostImageGuard(req, res, next) {
  const room = await getRoom(req, res); if (!room) return;
  const player = room.players.find((entry) => entry.id === cleanId(req.params.playerId));
  if (!player) return res.status(404).json({ error: "Add the player first" });
  req.room = room; req.player = player; next();
}
async function saveImages(req, res) {
  await validateUploadedImages(req.files);
  const idle = req.files?.idle?.[0]; const talking = req.files?.talking?.[0]; const data = {};
  if (idle) data.idleImage = `/uploads/${idle.filename}`; if (talking) data.talkingImage = `/uploads/${talking.filename}`;
  data.mediaMode = "png";
  const previous = req.player;
  const player = await prisma.player.update({ where: { id: previous.id }, data });
  if (idle) removeUploadedFile(previous.idleImage); if (talking) removeUploadedFile(previous.talkingImage);
  await prisma.room.update({ where: { id: req.room.id }, data: { updatedAt: new Date() } }); await broadcast(req.room.id); res.json(player);
}
app.post("/api/sessions/:sessionId/players/:playerId/images", requireHost, requireCsrf, hostImageGuard, upload.fields([{ name: "idle", maxCount: 1 }, { name: "talking", maxCount: 1 }]), saveImages);
app.delete("/api/sessions/:sessionId", requireHost, requireCsrf, async (req, res) => {
  const room = await getRoom(req, res); if (!room) return;
  for (const player of room.players) { removeUploadedFile(player.idleImage); removeUploadedFile(player.talkingImage); removeWebcamFile(room.id, player.id); }
  await prisma.room.delete({ where: { id: room.id } }); await audit(req, "room.delete", "success", room.id); res.status(204).end();
});
app.delete("/api/sessions/:sessionId/players/:playerId", requireHost, requireCsrf, async (req, res) => {
  const room = await getRoom(req, res); if (!room) return;
  const player = room.players.find((entry) => entry.id === cleanId(req.params.playerId));
  if (!player) return res.status(404).json({ error: "Player not found" });
  removeUploadedFile(player.idleImage); removeUploadedFile(player.talkingImage);
  removeWebcamFile(room.id, player.id);
  await prisma.player.delete({ where: { id: player.id } }); await prisma.room.update({ where: { id: room.id }, data: { updatedAt: new Date() } }); await broadcast(room.id); res.status(204).end();
});
app.post("/api/sessions/:sessionId/manual/:playerId", requireHost, requireCsrf, async (req, res) => {
  const room = await getRoom(req, res); if (!room) return;
  const id = cleanId(req.params.playerId); if (!room.players.some((player) => player.id === id)) return res.status(404).json({ error: "Player not found" });
  await prisma.presence.upsert({ where: { playerId: id }, create: { playerId: id, present: true, speaking: Boolean(req.body?.speaking), muted: Boolean(req.body?.muted), source: "manual" }, update: { present: true, speaking: Boolean(req.body?.speaking), muted: Boolean(req.body?.muted), source: "manual", lastSeen: new Date() } });
  await broadcast(room.id); res.json({ ok: true });
});

const validRoomToken = (value, expected) => value.length >= 20 && safeEqual(value, expected);
function requireParticipant(req, res, room, playerId) {
  if (!validRoomToken(req.params.joinToken, room.joinToken)) { res.status(401).json({ error: "Invalid room link" }); return null; }
  const player = room.players.find((entry) => entry.id === playerId);
  const cookieCredential = parseCookies(req)[guestCookieName(room.id)] || "";
  const [cookiePlayerId, cookieKey] = cookieCredential.split(".", 2);
  const cookieValid = cookiePlayerId === playerId && player?.joinKey && safeEqual(cookieKey, player.joinKey);
  const bearerValid = player?.joinKey && safeEqual(bearer(req), player.joinKey);
  if (!cookieValid && !bearerValid) { res.status(401).json({ error: "Invalid participant key" }); return null; }
  return player;
}
app.post("/api/join/:sessionId/:joinToken", joinLimit, async (req, res) => {
  const room = await getRoom(req, res); if (!room) return;
  if (!validRoomToken(req.params.joinToken, room.joinToken)) return res.status(401).json({ error: "Invalid room link" });
  const requestedId = cleanId(req.body?.playerId || "", "");
  const existingPlayer = room.players.find((player) => player.id === requestedId);
  const cookieCredential = parseCookies(req)[guestCookieName(room.id)] || "";
  const [cookiePlayerId, cookieKey] = cookieCredential.split(".", 2);
  if (existingPlayer?.joinKey && cookiePlayerId === existingPlayer.id && safeEqual(cookieKey, existingPlayer.joinKey)) {
    setCookie(res, guestCookieName(room.id), `${existingPlayer.id}.${existingPlayer.joinKey}`, 60 * 60 * 12, cookieSecure(req), true);
    return res.json({ playerId: existingPlayer.id, sessionName: room.name, player: existingPlayer });
  }
  const player = await prisma.player.create({ data: {
    id: token(8), roomId: room.id, name: cleanText(req.body?.name, "Player", 60), accent: /^#[0-9a-f]{6}$/i.test(req.body?.accent) ? req.body.accent : "#d0193c",
    pinned: false, joinKey: token(24), mediaMode: req.body?.mediaMode === "webcam" ? "webcam" : "png", speakingAnimation: speakingAnimation(req.body?.speakingAnimation), presence: { create: { source: "browser" } },
  } });
  await prisma.room.update({ where: { id: room.id }, data: { updatedAt: new Date() } }); await audit(req, "guest.join", "success", room.id, "guest"); await broadcast(room.id);
  setCookie(res, guestCookieName(room.id), `${player.id}.${player.joinKey}`, 60 * 60 * 12, cookieSecure(req), true);
  res.status(201).json({ playerId: player.id, sessionName: room.name, player });
});
async function guestGuard(req, res, next) {
  const room = await getRoom(req, res); if (!room) return;
  const player = requireParticipant(req, res, room, cleanId(req.params.playerId)); if (!player) return;
  req.room = room; req.player = player; next();
}
app.post("/api/join/:sessionId/:joinToken/:playerId/images", joinLimit, guestGuard, upload.fields([{ name: "idle", maxCount: 1 }, { name: "talking", maxCount: 1 }]), saveImages);
app.post("/api/join/:sessionId/:joinToken/:playerId/heartbeat", heartbeatLimit, guestGuard, async (req, res) => {
  await prisma.presence.upsert({ where: { playerId: req.player.id }, create: { playerId: req.player.id, present: true, speaking: Boolean(req.body?.speaking), muted: Boolean(req.body?.muted), source: "browser" }, update: { present: true, speaking: Boolean(req.body?.speaking), muted: Boolean(req.body?.muted), source: "browser", lastSeen: new Date() } });
  await broadcast(req.room.id); res.json({ ok: true });
});
app.post("/api/join/:sessionId/:joinToken/:playerId/leave", joinLimit, guestGuard, async (req, res) => {
  await prisma.presence.update({ where: { playerId: req.player.id }, data: { present: false, speaking: false, muted: false, lastSeen: new Date() } });
  setCookie(res, guestCookieName(req.room.id), "", 0, cookieSecure(req), true);
  await audit(req, "guest.leave", "success", req.room.id, "guest");
  await broadcast(req.room.id);
  res.status(204).end();
});
app.put("/api/join/:sessionId/:joinToken/:playerId/webcam-frame", webcamLimit, guestGuard, express.raw({ type: "image/jpeg", limit: "512kb" }), async (req, res) => {
  if (req.player.mediaMode !== "webcam") return res.status(409).json({ error: "This player is not using webcam mode" });
  if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: "Empty webcam frame" });
  const detected = await fileTypeFromBuffer(req.body);
  if (detected?.mime !== "image/jpeg") return res.status(400).json({ error: "Webcam frames must be JPEG images" });
  const destination = webcamFile(req.room.id, req.player.id);
  const temporary = `${destination}.${token(5)}.tmp`;
  fs.writeFileSync(temporary, req.body, { flag: "wx" });
  fs.renameSync(temporary, destination);
  res.status(204).end();
});
app.get("/api/webcam/:sessionId/:overlayToken/:playerId", async (req, res) => {
  const room = await getRoom(req, res); if (!room) return;
  if (!validRoomToken(req.params.overlayToken, room.overlayToken)) return res.status(401).end();
  const player = room.players.find((entry) => entry.id === cleanId(req.params.playerId));
  if (!player || player.mediaMode !== "webcam") return res.status(404).end();
  try {
    const frame = await fs.promises.readFile(webcamFile(room.id, player.id));
    res.set({ "Cache-Control": "no-store", "Content-Type": "image/jpeg" }).send(frame);
  } catch (error) {
    res.status(error?.code === "ENOENT" ? 404 : 500).end();
  }
});
app.get("/api/overlay/:sessionId/:overlayToken", async (req, res) => {
  const room = await getRoom(req, res); if (!room) return;
  if (!validRoomToken(req.params.overlayToken, room.overlayToken)) return res.status(401).json({ error: "Invalid overlay token" });
  res.json(publicRoom(room));
});
app.get("/api/events/:sessionId/:overlayToken", async (req, res) => {
  const room = await getRoom(req, res); if (!room) return;
  if (!validRoomToken(req.params.overlayToken, room.overlayToken)) return res.status(401).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" }); res.flushHeaders();
  const group = clients.get(room.id) || new Set(); group.add(res); clients.set(room.id, group); res.write(`data: ${JSON.stringify(publicRoom(room))}\n\n`);
  const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15000);
  req.on("close", () => { clearInterval(keepAlive); group.delete(res); if (!group.size) clients.delete(room.id); });
});

app.use(express.static("public", {
  dotfiles: "deny",
  maxAge: "1h",
  setHeaders: (res, filePath) => {
    if ([".html", ".js", ".css"].includes(path.extname(filePath))) res.set("Cache-Control", "no-store");
  },
}));
app.get(["/overlay/:sessionId/:overlayToken", "/join/:sessionId/:joinToken", "/setup", "/"], (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.resolve("public/index.html"));
});
app.use((error, req, res, _next) => {
  console.error(error);
  const clientError = error instanceof multer.MulterError || /Uploaded content|Image extension|Use PNG/.test(error.message || "");
  audit(req, "request.error", clientError ? "rejected" : "failure", req.path, "system");
  res.status(clientError ? 400 : 500).json({ error: clientError ? error.message : "Unexpected server error" });
});

await importLegacyState();
const server = app.listen(port, host, () => console.log(`Zephikyu PNGCalls is ready at http://${host}:${port}`));
async function shutdown() { server.close(async () => { await prisma.$disconnect(); process.exit(0); }); }
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
