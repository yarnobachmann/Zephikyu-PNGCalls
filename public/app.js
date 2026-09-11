const app = document.querySelector("#app");
document.title = "Zephikyu PNGCalls";
let sessionId = localStorage.getItem("pngcalls.sessionId") || localStorage.getItem("relay.sessionId");
const pathParts = location.pathname.split("/").filter(Boolean);
const isOverlay = pathParts[0] === "overlay" && pathParts.length >= 3;
const isJoin = pathParts[0] === "join" && pathParts.length >= 3;
let session = null;
let activeView = "overlay";
let csrfToken = null;
let discordConnection = null;
let dashboardEvents = null;
let placementEditing = false;
let selectedPlacementId = null;

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value)));
const nameFontValues = ["rounded", "comic", "typewriter", "classic", "bold"];
const normalizeNameFont = (value) => nameFontValues.includes(value) ? value : "rounded";
const nameFontOptions = (selected = "rounded") => [
  ["rounded", "Friendly rounded"],
  ["comic", "Handwritten"],
  ["typewriter", "Typewriter"],
  ["classic", "Classic serif"],
  ["bold", "Big and bold"],
].map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
const namePositionPresets = {
  overlay: { x: 0, y: 0 },
  below: { x: 0, y: 8 },
  above: { x: 0, y: -68 },
  left: { x: -14, y: -32 },
  right: { x: 14, y: -32 },
};
const namePositionOptions = (includeCurrent = true) => `${includeCurrent ? '<option value="current">Keep current position</option>' : ""}<option value="overlay">On the image</option><option value="below">Below</option><option value="above">Above</option><option value="left">Left side</option><option value="right">Right side</option>`;
function normalizeCrop(crop = {}) {
  return {
    zoom: clamp(crop.zoom || 1, 1, 8),
    x: clamp(crop.x ?? 50, 0, 100),
    y: clamp(crop.y ?? 50, 0, 100),
  };
}

function drawCroppedFrame(video, canvas, cropValue) {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
  const crop = normalizeCrop(cropValue);
  const targetAspect = canvas.width / canvas.height;
  const sourceAspect = video.videoWidth / video.videoHeight;
  const baseWidth = sourceAspect > targetAspect ? video.videoHeight * targetAspect : video.videoWidth;
  const baseHeight = sourceAspect > targetAspect ? video.videoHeight : video.videoWidth / targetAspect;
  const sourceWidth = baseWidth / crop.zoom;
  const sourceHeight = baseHeight / crop.zoom;
  const sourceX = (video.videoWidth - sourceWidth) * (crop.x / 100);
  const sourceY = (video.videoHeight - sourceHeight) * (crop.y / 100);
  canvas.getContext("2d").drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  return true;
}

function cropControlsMarkup(hidden = false) {
  return `<div id="crop-controls" class="crop-controls" ${hidden ? "hidden" : ""}>
    <div class="crop-heading"><strong>Crop camera</strong><button id="reset-crop" class="btn ghost compact" type="button">Reset</button></div>
    <label for="crop-zoom"><span>Zoom</span><output id="crop-zoom-value">1.0x</output></label><input id="crop-zoom" name="cropZoom" type="range" min="1" max="8" step="0.1" value="1" />
    <label for="crop-x"><span>Horizontal position</span><output id="crop-x-value">50%</output></label><input id="crop-x" name="cropX" type="range" min="0" max="100" step="1" value="50" />
    <label for="crop-y"><span>Vertical position</span><output id="crop-y-value">50%</output></label><input id="crop-y" name="cropY" type="range" min="0" max="100" step="1" value="50" />
  </div>`;
}

function bindCropControls(initialCrop = {}, onChange = () => {}) {
  const crop = normalizeCrop(initialCrop);
  const zoom = document.querySelector("#crop-zoom");
  const x = document.querySelector("#crop-x");
  const y = document.querySelector("#crop-y");
  zoom.value = String(crop.zoom);
  x.value = String(crop.x);
  y.value = String(crop.y);
  const current = () => normalizeCrop({ zoom: zoom.value, x: x.value, y: y.value });
  const sync = () => {
    const value = current();
    document.querySelector("#crop-zoom-value").textContent = `${value.zoom.toFixed(1)}x`;
    document.querySelector("#crop-x-value").textContent = `${value.x}%`;
    document.querySelector("#crop-y-value").textContent = `${value.y}%`;
    onChange(value);
  };
  [zoom, x, y].forEach((input) => { input.oninput = sync; });
  document.querySelector("#reset-crop").onclick = () => {
    zoom.value = "1";
    x.value = "50";
    y.value = "50";
    sync();
  };
  sync();
  return current;
}

function avatarMarkup(player) {
  const isWebcam = player.mediaMode === "webcam";
  const avatarFallback = player.useDiscordAvatar ? player.discordAvatar : null;
  const image = isWebcam ? player.webcamImage : player.speaking ? player.talkingImage || player.idleImage || avatarFallback : player.idleImage || avatarFallback;
  const animation = ["bounce", "pulse", "shake", "glow"].includes(player.speakingAnimation) ? player.speakingAnimation : "none";
  const font = normalizeNameFont(player.nameFont);
  const positioned = player.positionX !== null && player.positionX !== undefined && player.positionY !== null && player.positionY !== undefined;
  const x = clamp(player.positionX ?? 50, 0, 100);
  const y = clamp(player.positionY ?? 50, 0, 100);
  const size = clamp(player.displaySize || 1, 0.4, 2.5);
  const nameSize = clamp(player.nameSize || 1, 0.5, 3);
  const nameX = clamp(player.nameOffsetX || 0, -100, 100);
  const nameY = clamp(player.nameOffsetY || 0, -100, 100);
  const layer = Math.round(clamp(player.displayLayer || 0, 0, 1000));
  const nameBackgroundClass = player.nameBackground === "none" ? " no-background" : "";
  return `<article class="avatar font-${font} ${positioned ? "custom-position" : ""} ${isWebcam ? "webcam" : ""} ${player.speaking ? "speaking" : ""} animation-${animation}" data-player-id="${escapeHtml(player.id)}" style="--accent:${escapeHtml(player.accent)};--x:${x}%;--y:${y}%;--size:${size};--layer:${layer};--name-size:${nameSize};--name-x:${nameX}cqw;--name-y:${nameY}cqh;--name-bg:${escapeHtml(player.nameBackgroundColor || "#090305")}">
    <div class="avatar-visual">${image ? `<img class="avatar-img ${isWebcam ? "webcam-img" : ""}" src="${escapeHtml(image)}${isWebcam ? `?v=${Date.now()}` : ""}" ${isWebcam ? `data-webcam-src="${escapeHtml(image)}"` : ""} alt="${isWebcam ? `${escapeHtml(player.name)} webcam` : ""}" />` : `<div class="avatar-fallback"><span>${isWebcam ? "CAMERA" : player.speaking ? "TALK" : "IDLE"}</span></div>`}</div>
    <div class="avatar-name${nameBackgroundClass}" title="Drag to move the name">${escapeHtml(player.name)}</div>
    <button class="avatar-resize" type="button" aria-label="Resize ${escapeHtml(player.name)}" title="Drag to resize">↘</button>
  </article>`;
}

setInterval(() => {
  document.querySelectorAll("img[data-webcam-src]").forEach((image) => {
    if (image.dataset.webcamLive === "true") return;
    if (image.dataset.webcamLoading === "true") return;
    image.dataset.webcamLoading = "true";
    const nextFrame = new Image();
    nextFrame.onload = () => {
      if (image.isConnected) image.src = nextFrame.src;
      delete image.dataset.webcamLoading;
    };
    nextFrame.onerror = () => { delete image.dataset.webcamLoading; };
    nextFrame.src = `${image.dataset.webcamSrc}?v=${Date.now()}`;
  });
}, 500);

function connectWebcamStream(image, roomId, overlayToken, playerId) {
  if (image.webcamSocket && image.webcamSocket.readyState < 2) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws/view/${encodeURIComponent(roomId)}/${encodeURIComponent(overlayToken)}/${encodeURIComponent(playerId)}`);
  socket.binaryType = "blob";
  image.webcamSocket = socket;
  socket.onopen = () => { image.dataset.webcamLive = "true"; };
  const displayNewestFrame = () => {
    const frame = image.webcamQueuedFrame;
    if (!frame || image.webcamDecoding) return;
    image.webcamQueuedFrame = null;
    image.webcamDecoding = true;
    const frameUrl = URL.createObjectURL(frame);
    const nextFrame = new Image();
    nextFrame.onload = () => {
      if (!image.isConnected) {
        URL.revokeObjectURL(frameUrl);
        image.webcamDecoding = false;
        socket.close();
        return;
      }
      const previous = image.dataset.webcamBlob;
      image.src = frameUrl;
      image.dataset.webcamBlob = frameUrl;
      if (previous) URL.revokeObjectURL(previous);
      image.webcamDecoding = false;
      displayNewestFrame();
    };
    nextFrame.onerror = () => {
      URL.revokeObjectURL(frameUrl);
      image.webcamDecoding = false;
      displayNewestFrame();
    };
    nextFrame.src = frameUrl;
  };
  socket.onmessage = (event) => {
    image.webcamQueuedFrame = event.data;
    displayNewestFrame();
  };
  socket.onclose = () => {
    image.dataset.webcamLive = "false";
    if (image.isConnected) setTimeout(() => { if (image.isConnected) connectWebcamStream(image, roomId, overlayToken, playerId); }, 1500);
  };
}

async function api(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const securityHeaders = csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method) ? { "X-CSRF-Token": csrfToken } : {};
  const response = await fetch(url, {
    ...options,
    cache: options.cache || (method === "GET" ? "no-store" : undefined),
    headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...securityHeaders, ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 1800);
}

const tutorialImage = "/assets/tutorial-zeph.gif";
function tutorialSteps() {
  if (isJoin && document.querySelector("#join-form")) return [
    ["input[name='name']", "Start with the name that should appear below your avatar or camera."],
    ["#name-font", "Choose how your display name should look in the room and OBS."],
    ["#media-mode", "Choose PNG images or Webcam. Selecting Webcam hides the PNG uploads and opens the camera setup."],
    ["#find-cameras", "Find cameras lists every detected source. If one is busy, choose a different camera from the list."],
    ["input[name='accent']", "Pick the accent used for your speaking outline, camera border, and glow."],
    ["#animate-speaking", "Turn on a speaking animation, then choose the style beside it."],
    ["#join-form button[type='submit']", "Join when the preview and settings look right. Keep this page open while playing."],
  ];
  if (isJoin) return [
    ["#camera-output-preview", "This is the exact camera crop sent to the overlay."],
    ["#crop-controls", "Adjust zoom and position here. Changes are saved on this device."],
    [".meter", "The meter shows microphone activity. Your speaking state changes automatically."],
    ["#leave-room", "Use this when you want to leave the overlay and forget this room on this device."],
  ];
  if (document.querySelector("#auth-form")) return [];
  if (document.querySelector("#create-form")) return [
    ["#create-form input[name='name']", "Give the room a name that you will recognize in the host dashboard."],
    ["#create-form button[type='submit']", "Create the room to receive separate player invitation and OBS overlay links."],
  ];
  return [
    ["#copy-join", "Copy this invitation link and send it to every player who should appear."],
    ["#copy-overlay", "Copy this private overlay link into an OBS Browser Source."],
    ["#edit-placement", "Arrange players lets you drag and resize everyone. The same positions appear in OBS."],
    ["[data-view='players']", "The player room shows who has joined and lets you edit each player."],
    ["[data-view='settings']", "Settings control the room name, layout, background, and optional Discord connection."],
  ];
}

function startTutorial() {
  const steps = tutorialSteps().map(([selector, copy]) => ({ target: document.querySelector(selector), copy })).filter((step) => step.target?.getClientRects().length);
  if (!steps.length) return toast("Open a room or player setup first, then press Zeph for help.");
  let index = 0;
  const popover = document.createElement("section");
  popover.className = "tutorial-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-live", "polite");
  document.body.append(popover);
  const cleanup = () => {
    document.querySelectorAll(".tutorial-highlight").forEach((node) => node.classList.remove("tutorial-highlight"));
    popover.remove();
    localStorage.setItem("pngcalls.tutorialSeen", "true");
  };
  const show = () => {
    document.querySelectorAll(".tutorial-highlight").forEach((node) => node.classList.remove("tutorial-highlight"));
    const step = steps[index];
    step.target.classList.add("tutorial-highlight");
    step.target.scrollIntoView({ behavior: "smooth", block: "center" });
    popover.innerHTML = `<div class="tutorial-copy"><img src="${tutorialImage}" alt="" /><div><span class="eyebrow">Step ${index + 1} of ${steps.length}</span><p>${step.copy}</p></div></div><div class="tutorial-actions"><button class="btn ghost tutorial-close" type="button">Close</button><div><button class="btn ghost tutorial-back" type="button" ${index === 0 ? "disabled" : ""}>Back</button><button class="btn primary tutorial-next" type="button">${index === steps.length - 1 ? "Finish" : "Next"}</button></div></div>`;
    setTimeout(() => {
      const rect = step.target.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const below = rect.bottom + 14;
      popover.style.top = `${below + popoverRect.height < innerHeight - 12 ? below : Math.max(12, rect.top - popoverRect.height - 14)}px`;
      popover.style.left = `${clamp(rect.left, 12, innerWidth - popoverRect.width - 12)}px`;
    }, 220);
    popover.querySelector(".tutorial-close").onclick = cleanup;
    popover.querySelector(".tutorial-back").onclick = () => { if (index > 0) { index -= 1; show(); } };
    popover.querySelector(".tutorial-next").onclick = () => { if (index === steps.length - 1) cleanup(); else { index += 1; show(); } };
  };
  show();
}

function mountTutorialHelper() {
  if (isOverlay || document.querySelector(".tutorial-helper")) return;
  if (!app.children.length) { setTimeout(mountTutorialHelper, 400); return; }
  const helper = document.createElement("aside");
  helper.className = "tutorial-helper";
  const helperCopy = document.querySelector("#auth-form") ? "You are not allowed here you secondhand scoobydoo shoe." : "Need help? Press me.";
  helper.innerHTML = `<button type="button" aria-label="Open PNGCalls tutorial"><span class="tutorial-balloon">${helperCopy}</span><img src="${tutorialImage}" alt="Zeph tutorial helper" /></button>`;
  document.body.append(helper);
  if (document.querySelector("#auth-form")) {
    helper.querySelector("button").setAttribute("aria-label", "Zeph guards the host login");
    return;
  }
  helper.querySelector("button").onclick = startTutorial;
  if (localStorage.getItem("pngcalls.tutorialSeen")) return;
  const prompt = document.createElement("div");
  prompt.className = "tutorial-prompt";
  const authPage = Boolean(document.querySelector("#auth-form"));
  prompt.innerHTML = `<section class="tutorial-prompt-card" role="dialog" aria-modal="true" aria-labelledby="tutorial-title"><img src="${tutorialImage}" alt="" /><div><div class="eyebrow">${authPage ? "Host territory" : "Welcome to PNGCalls"}</div><h2 id="tutorial-title">${authPage ? "Wrong door." : "Is this your first time here?"}</h2><p>${authPage ? "You are not allowed here you secondhand scoobydoo shoe." : "Zeph can show you where everything is."}</p><div class="actions"><button class="btn primary tutorial-yes" type="button">${authPage ? "I am the host" : "Yes, show me"}</button><button class="btn ghost tutorial-no" type="button">${authPage ? "Back away" : "No, thanks"}</button></div></div></section>`;
  document.body.append(prompt);
  prompt.querySelector(".tutorial-yes").onclick = () => { prompt.remove(); localStorage.setItem("pngcalls.tutorialSeen", "true"); startTutorial(); };
  prompt.querySelector(".tutorial-no").onclick = () => { prompt.remove(); localStorage.setItem("pngcalls.tutorialSeen", "true"); };
  prompt.querySelector(".tutorial-yes").focus();
}

function brandMarkup() {
  return `<div class="brand"><img class="brand-gif" src="/assets/zeph.gif" alt="Zephikyu" /><span>Zephikyu <i>PNGCalls</i></span></div>`;
}

function studioShelfMarkup(extraClass = "") {
  return `<div class="studio-shelf ${extraClass}" aria-label="Studio sound shelf">
    <img class="studio-shelves" src="/assets/studio/shelves.png" alt="" />
    <button class="shelf-item shelf-monster" type="button" data-shelf-sound="/assets/studio/monster-drink.mp3" aria-label="Play Monster can sound"><img src="/assets/studio/monster.png" alt="" /></button>
    <button class="shelf-item shelf-foxy" type="button" data-shelf-sound="/assets/studio/foxy-scream.mp3" aria-label="Play Foxy sound"><img src="/assets/studio/foxy.png" alt="" /></button>
    <button class="shelf-item shelf-funko" type="button" data-shelf-sound="/assets/studio/funko-voice.mp3" aria-label="Play Funko sound"><img src="/assets/studio/funko.png" alt="" /></button>
    <button class="shelf-item shelf-mimikyu" type="button" data-shelf-sound="/assets/studio/mimikyu-cry.mp3" aria-label="Play Mimikyu sound"><img src="/assets/studio/mimikyu-head.png" alt="" /></button>
  </div>`;
}

let shelfAudio = null;
document.addEventListener("click", (event) => {
  const item = event.target.closest("[data-shelf-sound]");
  if (!item) return;
  if (shelfAudio) {
    shelfAudio.pause();
    shelfAudio.currentTime = 0;
  }
  document.querySelectorAll(".shelf-item.playing").forEach((node) => node.classList.remove("playing"));
  shelfAudio = new Audio(item.dataset.shelfSound);
  item.classList.add("playing");
  shelfAudio.addEventListener("ended", () => item.classList.remove("playing"), { once: true });
  shelfAudio.play().catch(() => {
    item.classList.remove("playing");
    toast("Your browser blocked the sound. Press the item again.");
  });
});

function studioDeskMarkup() {
  return `<div class="studio-desk" aria-hidden="true">
    <img class="studio-chair" src="/assets/studio/chair.png" alt="" />
    <img class="studio-foxy" src="/assets/studio/foxy.png" alt="" />
    <img class="studio-desk-top" src="/assets/studio/desk.png" alt="" />
  </div>`;
}

function renderAuth(needsSetup) {
  stopDashboardLive();
  app.innerHTML = `<main class="auth-page">
    <section class="auth-crest"><img class="auth-banner" src="/assets/team-banner.png" alt="Zephikyu's favorite team" /><div class="auth-banner-copy"><div class="eyebrow">Zephikyu PNGCalls</div><h1>Enter the night.</h1><p>Your private avatar and camera room for every stream and every game.</p></div></section>
    <section class="auth-panel">
      ${brandMarkup()}
      <div><div class="eyebrow">${needsSetup ? "First-time setup" : "Host access"}</div><h2>${needsSetup ? "Create the host account" : "Welcome back"}</h2><p class="subtle">Players use invite links and never need an account.</p></div>
      <form id="auth-form" class="stack">
        <div class="field"><label>Username</label><input class="input" name="username" required minlength="2" autocomplete="username" /></div>
        <div class="field"><label>Password</label><input class="input" name="password" type="password" required minlength="12" autocomplete="${needsSetup ? "new-password" : "current-password"}" /></div>
        <button class="btn primary" type="submit">${needsSetup ? "Create host account" : "Sign in"}</button>
        <p id="auth-error" class="form-error" role="alert"></p>
      </form>
    </section>
  </main>`;
  document.querySelector("#auth-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.submitter;
    button.disabled = true;
    try {
      const result = await api(`/api/auth/${needsSetup ? "setup" : "login"}`, { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
      csrfToken = result.csrfToken;
      await initializeHost();
    } catch (error) {
      document.querySelector("#auth-error").textContent = error.message;
      button.disabled = false;
    }
  };
}

function renderWelcome() {
  stopDashboardLive();
  app.innerHTML = `<main class="welcome">
    <section class="welcome-copy">
      <div class="eyebrow">Zephikyu · Self-hosted · OBS ready</div>
      <h1>Awaken your crew<span class="slash">.</span></h1>
      <p>Give every player a speaking-aware avatar or webcam without game mods. Invite links work on their own, and Discord connection is optional.</p>
      ${studioDeskMarkup()}
    </section>
    <section class="welcome-panel">
      <div class="eyebrow">New overlay</div>
      <h2>Make a room for your crew.</h2>
      <form id="create-form" class="field">
        <label for="room-name">Overlay name</label>
        <input id="room-name" class="input" value="The Crimson Room" maxlength="80" />
        <button class="btn" type="submit">Create private overlay</button>
      </form>
      <div class="steps">
        <div class="step"><span class="mono">01</span><span>Share one browser join link with the players.</span></div>
        <div class="step"><span class="mono">02</span><span>Each player chooses PNG images or a webcam and allows microphone access.</span></div>
        <div class="step"><span class="mono">03</span><span>Paste the separate overlay link into OBS.</span></div>
      </div>
    </section>
  </main>`;
  document.querySelector("#create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api("/api/sessions", { method: "POST", body: JSON.stringify({ name: document.querySelector("#room-name").value }) });
    localStorage.setItem("pngcalls.sessionId", result.sessionId);
    sessionId = result.sessionId;
    await loadDashboard();
  });
}

function stopDashboardLive() {
  dashboardEvents?.close();
  dashboardEvents = null;
}

function playerSignature(players = []) {
  return players.map((player) => [player.id, player.mediaMode, player.idleImage || "", player.talkingImage || "", player.discordAvatar || "", player.useDiscordAvatar !== false, player.nameBackground || "solid"].join(":")).join("|");
}

function hasCustomPlacement(players = []) {
  return players.some((player) => player.positionX !== null && player.positionX !== undefined && player.positionY !== null && player.positionY !== undefined);
}

function applyPlayerState(avatar, player, includePlacement = true) {
  avatar.classList.toggle("speaking", Boolean(player.speaking));
  avatar.classList.remove("animation-none", "animation-bounce", "animation-pulse", "animation-shake", "animation-glow");
  avatar.classList.add(`animation-${["bounce", "pulse", "shake", "glow"].includes(player.speakingAnimation) ? player.speakingAnimation : "none"}`);
  avatar.classList.remove(...nameFontValues.map((font) => `font-${font}`));
  avatar.classList.add(`font-${normalizeNameFont(player.nameFont)}`);
  avatar.style.setProperty("--accent", player.accent);
  avatar.style.setProperty("--name-size", clamp(player.nameSize || 1, 0.5, 3));
  avatar.style.setProperty("--name-x", `${clamp(player.nameOffsetX || 0, -100, 100)}cqw`);
  avatar.style.setProperty("--name-y", `${clamp(player.nameOffsetY || 0, -100, 100)}cqh`);
  avatar.style.setProperty("--name-bg", player.nameBackgroundColor || "#090305");
  const nameLabel = avatar.querySelector(".avatar-name");
  nameLabel.textContent = player.name;
  nameLabel.classList.toggle("no-background", player.nameBackground === "none");
  if (includePlacement && !avatar.classList.contains("dragging")) {
    const positioned = player.positionX !== null && player.positionX !== undefined && player.positionY !== null && player.positionY !== undefined;
    avatar.classList.toggle("custom-position", positioned);
    avatar.style.setProperty("--x", `${clamp(player.positionX ?? 50, 0, 100)}%`);
    avatar.style.setProperty("--y", `${clamp(player.positionY ?? 50, 0, 100)}%`);
    avatar.style.setProperty("--size", clamp(player.displaySize || 1, 0.4, 2.5));
    avatar.style.setProperty("--layer", Math.round(clamp(player.displayLayer || 0, 0, 1000)));
  }
  if (player.mediaMode !== "webcam") {
    const avatarFallback = player.useDiscordAvatar ? player.discordAvatar : null;
    const source = player.speaking ? player.talkingImage || player.idleImage || avatarFallback : player.idleImage || avatarFallback;
    const image = avatar.querySelector(".avatar-img");
    if (image && source && image.getAttribute("src") !== source) image.src = source;
  }
}

function connectDashboardWebcams() {
  app.querySelectorAll(".preview img[data-webcam-src]").forEach((image) => connectWebcamStream(image, session.id, session.overlayToken, image.closest(".avatar").dataset.playerId));
}

function syncDashboardLive(data) {
  if (!session || !document.querySelector(".shell")) return;
  if (playerSignature(session.players) !== playerSignature(data.players)) {
    const secrets = { joinToken: session.joinToken, overlayToken: session.overlayToken };
    session = { ...data, ...secrets };
    renderDashboard();
    return;
  }
  session.onlineCount = data.onlineCount;
  session.updatedAt = data.updatedAt;
  const preview = document.querySelector("#live-preview");
  data.players.forEach((incoming, index) => {
    const current = session.players[index];
    const avatar = preview?.querySelector(`.avatar[data-player-id="${CSS.escape(current.id)}"]`);
    const draftPlacement = avatar?.classList.contains("dragging") ? {
      positionX: current.positionX, positionY: current.positionY, displaySize: current.displaySize, displayLayer: current.displayLayer, nameSize: current.nameSize, nameOffsetX: current.nameOffsetX, nameOffsetY: current.nameOffsetY,
    } : null;
    Object.assign(current, incoming, draftPlacement || {});
  });
  if (preview) preview.className = `preview ${session.background} ${session.layout} ${hasCustomPlacement(session.players) ? "custom-layout" : ""} ${placementEditing ? "placement-editing" : ""}`;
  session.players.forEach((player) => {
    const avatar = preview?.querySelector(`.avatar[data-player-id="${CSS.escape(player.id)}"]`);
    if (avatar) applyPlayerState(avatar, player);
    document.querySelector(`.mic[data-id="${CSS.escape(player.id)}"]`)?.classList.toggle("talking", Boolean(player.speaking));
  });
  const liveBadge = document.querySelector("#live-count-badge");
  if (liveBadge) {
    liveBadge.classList.toggle("live", Boolean(data.onlineCount));
    liveBadge.textContent = data.onlineCount ? `${data.onlineCount} ONLINE` : "PREVIEW";
  }
  const roomNumber = document.querySelector(".room-number");
  if (roomNumber) roomNumber.textContent = data.onlineCount;
  const railStatus = document.querySelector("#rail-status");
  if (railStatus) railStatus.innerHTML = `<span class="dot ${data.onlineCount ? "live" : ""}"></span>${data.onlineCount ? `${data.onlineCount} connected` : "Waiting for players"}`;
}

function startDashboardLive() {
  if (dashboardEvents?.roomId === session.id) return;
  stopDashboardLive();
  dashboardEvents = new EventSource(`/api/events/${session.id}/${session.overlayToken}`);
  dashboardEvents.roomId = session.id;
  dashboardEvents.onmessage = (event) => syncDashboardLive(JSON.parse(event.data));
}

const placementPayload = (players) => players.map((player) => ({
  id: player.id,
  x: clamp(player.positionX ?? 50, 0, 100),
  y: clamp(player.positionY ?? 50, 0, 100),
  size: clamp(player.displaySize || 1, 0.4, 2.5),
  layer: Math.round(clamp(player.displayLayer || 0, 0, 1000)),
  nameSize: clamp(player.nameSize || 1, 0.5, 3),
  nameX: clamp(player.nameOffsetX || 0, -100, 100),
  nameY: clamp(player.nameOffsetY || 0, -100, 100),
}));

async function savePlacements(players) {
  return api(`/api/sessions/${session.id}/placements`, { method: "PUT", body: JSON.stringify({ players: placementPayload(players) }) });
}

function bindPlacementEditor() {
  const preview = document.querySelector("#live-preview");
  const editButton = document.querySelector("#edit-placement");
  const resetButton = document.querySelector("#reset-placement");
  if (!preview || !editButton || !resetButton) return;

  editButton.onclick = async () => {
    if (placementEditing) {
      placementEditing = false;
      selectedPlacementId = null;
      renderDashboard();
      return;
    }
    const previewRect = preview.getBoundingClientRect();
    session.players.forEach((player, index) => {
      if (player.positionX !== null && player.positionX !== undefined && player.positionY !== null && player.positionY !== undefined) return;
      const avatar = preview.querySelector(`.avatar[data-player-id="${CSS.escape(player.id)}"]`);
      const rect = avatar?.getBoundingClientRect();
      player.positionX = rect ? clamp(((rect.left + rect.width / 2 - previewRect.left) / previewRect.width) * 100, 0, 100) : 50;
      player.positionY = rect ? clamp(((rect.top + rect.height / 2 - previewRect.top) / previewRect.height) * 100, 0, 100) : 50;
      player.displaySize = player.displaySize || 1;
      player.nameSize = player.nameSize || 1;
      player.nameOffsetX = player.nameOffsetX || 0;
      player.nameOffsetY = player.nameOffsetY || 0;
      player.displayLayer = index;
    });
    selectedPlacementId = session.players[0]?.id || null;
    placementEditing = true;
    const players = [...session.players];
    renderDashboard();
    try { await savePlacements(players); }
    catch (error) { toast(error.message); }
  };

  resetButton.onclick = async () => {
    if (!confirm("Reset every player to the selected automatic layout?")) return;
    resetButton.disabled = true;
    try {
      await api(`/api/sessions/${session.id}/placements`, { method: "PUT", body: JSON.stringify({ reset: true }) });
      session.players.forEach((player) => Object.assign(player, { positionX: null, positionY: null, displaySize: 1, displayLayer: 0, nameSize: 1, nameOffsetX: 0, nameOffsetY: 0 }));
      placementEditing = false;
      selectedPlacementId = null;
      renderDashboard();
      toast("Automatic layout restored");
    } catch (error) {
      resetButton.disabled = false;
      toast(error.message);
    }
  };

  if (!placementEditing) return;
  const sizeInput = document.querySelector("#placement-size");
  const sizeOutput = document.querySelector("#placement-size-output");
  const nameSizeInput = document.querySelector("#name-size");
  const nameSizeOutput = document.querySelector("#name-size-output");
  const namePositionInput = document.querySelector("#name-position");
  const selectedName = document.querySelector("#selected-placement-name");
  const selectedPlayer = () => session.players.find((entry) => entry.id === selectedPlacementId) || session.players[0];
  const syncSizeControls = () => {
    const player = selectedPlayer();
    if (!player || !sizeInput || !sizeOutput || !nameSizeInput || !nameSizeOutput || !selectedName) return;
    selectedPlacementId = player.id;
    sizeInput.value = String(clamp(player.displaySize || 1, 0.4, 2.5));
    sizeOutput.textContent = `${Math.round(Number(sizeInput.value) * 100)}%`;
    nameSizeInput.value = String(clamp(player.nameSize || 1, 0.5, 3));
    nameSizeOutput.textContent = `${Math.round(Number(nameSizeInput.value) * 100)}%`;
    selectedName.textContent = `Arrange ${player.name}`;
    preview.querySelectorAll(".avatar").forEach((entry) => entry.classList.toggle("placement-selected", entry.dataset.playerId === player.id));
  };
  const setSelectedSize = (size, save = false) => {
    const player = selectedPlayer();
    if (!player) return;
    player.displaySize = clamp(size, 0.4, 2.5);
    preview.querySelector(`.avatar[data-player-id="${CSS.escape(player.id)}"]`)?.style.setProperty("--size", player.displaySize);
    syncSizeControls();
    if (save) savePlacements([player]).catch((error) => toast(error.message));
  };
  if (sizeInput) {
    sizeInput.oninput = () => setSelectedSize(sizeInput.value);
    sizeInput.onchange = () => setSelectedSize(sizeInput.value, true);
  }
  document.querySelector("#placement-smaller")?.addEventListener("click", () => setSelectedSize((selectedPlayer()?.displaySize || 1) - 0.1, true));
  document.querySelector("#placement-larger")?.addEventListener("click", () => setSelectedSize((selectedPlayer()?.displaySize || 1) + 0.1, true));
  const setSelectedNameSize = (size, save = false) => {
    const player = selectedPlayer();
    if (!player) return;
    player.nameSize = clamp(size, 0.5, 3);
    preview.querySelector(`.avatar[data-player-id="${CSS.escape(player.id)}"]`)?.style.setProperty("--name-size", player.nameSize);
    syncSizeControls();
    if (save) savePlacements([player]).catch((error) => toast(error.message));
  };
  if (nameSizeInput) {
    nameSizeInput.oninput = () => setSelectedNameSize(nameSizeInput.value);
    nameSizeInput.onchange = () => setSelectedNameSize(nameSizeInput.value, true);
  }
  document.querySelector("#name-smaller")?.addEventListener("click", () => setSelectedNameSize((selectedPlayer()?.nameSize || 1) - 0.1, true));
  document.querySelector("#name-larger")?.addEventListener("click", () => setSelectedNameSize((selectedPlayer()?.nameSize || 1) + 0.1, true));
  if (namePositionInput) namePositionInput.onchange = () => {
    const player = selectedPlayer();
    const preset = namePositionPresets[namePositionInput.value];
    if (!player || !preset) return;
    player.nameOffsetX = preset.x;
    player.nameOffsetY = preset.y;
    const avatar = preview.querySelector(`.avatar[data-player-id="${CSS.escape(player.id)}"]`);
    avatar?.style.setProperty("--name-x", `${player.nameOffsetX}cqw`);
    avatar?.style.setProperty("--name-y", `${player.nameOffsetY}cqh`);
    namePositionInput.value = "current";
    savePlacements([player]).catch((error) => toast(error.message));
  };
  preview.querySelectorAll(".avatar").forEach((avatar) => {
    const player = session.players.find((entry) => entry.id === avatar.dataset.playerId);
    if (!player) return;
    avatar.tabIndex = 0;
    avatar.onpointerdown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const resizing = Boolean(event.target.closest(".avatar-resize"));
      const movingName = Boolean(event.target.closest(".avatar-name"));
      const previewRect = preview.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const initialX = clamp(player.positionX ?? 50, 0, 100);
      const initialY = clamp(player.positionY ?? 50, 0, 100);
      const initialSize = clamp(player.displaySize || 1, 0.4, 2.5);
      const initialNameX = clamp(player.nameOffsetX || 0, -100, 100);
      const initialNameY = clamp(player.nameOffsetY || 0, -100, 100);
      selectedPlacementId = player.id;
      syncSizeControls();
      player.displayLayer = Math.min(1000, Math.max(0, ...session.players.map((entry) => entry.displayLayer || 0)) + 1);
      avatar.classList.add("dragging", "custom-position");
      avatar.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        if (movingName) {
          player.nameOffsetX = clamp(initialNameX + ((moveEvent.clientX - startX) / previewRect.width) * 100, -100, 100);
          player.nameOffsetY = clamp(initialNameY + ((moveEvent.clientY - startY) / previewRect.height) * 100, -100, 100);
        } else if (resizing) {
          const resizeDistance = ((moveEvent.clientX - startX) + (moveEvent.clientY - startY)) / 2;
          player.displaySize = clamp(initialSize + resizeDistance / 140, 0.4, 2.5);
          if (sizeInput) sizeInput.value = String(player.displaySize);
          if (sizeOutput) sizeOutput.textContent = `${Math.round(player.displaySize * 100)}%`;
        } else {
          player.positionX = clamp(initialX + ((moveEvent.clientX - startX) / previewRect.width) * 100, 0, 100);
          player.positionY = clamp(initialY + ((moveEvent.clientY - startY) / previewRect.height) * 100, 0, 100);
        }
        avatar.style.setProperty("--x", `${player.positionX}%`);
        avatar.style.setProperty("--y", `${player.positionY}%`);
        avatar.style.setProperty("--size", player.displaySize);
        avatar.style.setProperty("--name-x", `${player.nameOffsetX || 0}cqw`);
        avatar.style.setProperty("--name-y", `${player.nameOffsetY || 0}cqh`);
        avatar.style.setProperty("--layer", player.displayLayer);
      };
      const finish = () => {
        avatar.classList.remove("dragging");
        avatar.onpointermove = null;
        avatar.onpointerup = null;
        avatar.onpointercancel = null;
        savePlacements([player]).catch((error) => toast(error.message));
      };
      avatar.onpointermove = move;
      avatar.onpointerup = finish;
      avatar.onpointercancel = finish;
    };
    avatar.onkeydown = (event) => {
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!moves[event.key]) return;
      event.preventDefault();
      player.positionX = clamp((player.positionX ?? 50) + moves[event.key][0], 0, 100);
      player.positionY = clamp((player.positionY ?? 50) + moves[event.key][1], 0, 100);
      avatar.style.setProperty("--x", `${player.positionX}%`);
      avatar.style.setProperty("--y", `${player.positionY}%`);
      savePlacements([player]).catch((error) => toast(error.message));
    };
  });
  syncSizeControls();
}

async function chooseAutomaticLayout(layout) {
  await api(`/api/sessions/${session.id}/placements`, { method: "PUT", body: JSON.stringify({ reset: true }) });
  const secrets = { joinToken: session.joinToken, overlayToken: session.overlayToken };
  session = await api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ layout }) });
  Object.assign(session, secrets);
  session.players.forEach((player) => Object.assign(player, { positionX: null, positionY: null, displaySize: 1, displayLayer: 0, nameSize: 1, nameOffsetX: 0, nameOffsetY: 0 }));
  placementEditing = false;
  selectedPlacementId = null;
  renderDashboard();
  toast(`${layout[0].toUpperCase()}${layout.slice(1)} layout applied to preview and OBS`);
}

function renderDashboard() {
  app.querySelectorAll("img[data-webcam-src]").forEach((image) => {
    image.webcamSocket?.close();
    if (image.dataset.webcamBlob) URL.revokeObjectURL(image.dataset.webcamBlob);
  });
  const origin = location.origin;
  const overlayUrl = `${origin}/overlay/${session.id}/${session.overlayToken}`;
  const joinUrl = `${origin}/join/${session.id}/${session.joinToken}`;
  const players = session.players || [];
  const customArrangement = hasCustomPlacement(players);
  app.innerHTML = `<div class="shell">
    <aside class="rail">
      ${brandMarkup()}
      <nav class="nav" aria-label="Dashboard"><button class="nav-item ${activeView === "overlay" ? "active" : ""}" data-view="overlay">◫ Overlay</button><button class="nav-item ${activeView === "players" ? "active" : ""}" data-view="players">⌁ Player room</button><button class="nav-item ${activeView === "settings" ? "active" : ""}" data-view="settings">⚙ Settings</button></nav>
      ${studioShelfMarkup()}
      <div class="rail-note"><div id="rail-status" class="status-line"><span class="dot ${session.onlineCount ? "live" : ""}"></span>${session.onlineCount ? `${session.onlineCount} connected` : "Waiting for players"}</div>${session.companion?.online ? `Discord companion connected${session.companion.channelName ? ` to ${escapeHtml(session.companion.channelName)}` : ""}.` : "Invite links work alone. Discord is optional."}</div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div><div class="eyebrow">Overlay workspace</div><h1>${escapeHtml(session.name)}</h1></div>
        <div class="actions"><button id="copy-join" class="btn ghost">Copy player link</button><button class="btn ghost danger" type="button" data-reset-player-link>Reset player link</button><button id="add-player" class="btn primary">Add manually</button></div>
      </header>
      <section class="view-panel ${activeView === "overlay" ? "active" : ""}" data-panel="overlay"><div class="grid">
        <section class="card">
          <div class="card-head"><div><h2>Live preview</h2><p class="subtle">This now follows the same live feed as OBS.</p></div><span id="live-count-badge" class="badge ${session.onlineCount ? "live" : ""}">${session.onlineCount ? `${session.onlineCount} ONLINE` : "PREVIEW"}</span></div>
          <div class="placement-toolbar"><button id="edit-placement" class="btn ${placementEditing ? "primary" : "ghost"}" type="button">${placementEditing ? "Done arranging" : "Arrange players"}</button><button id="reset-placement" class="btn ghost" type="button" ${customArrangement ? "" : "hidden"}>Reset arrangement</button><span>${placementEditing ? "Drag players to move them. Select one and use the size controls." : "Positions are shared with the OBS browser source."}</span></div>
          ${placementEditing && players.length ? `<div class="placement-controls"><strong id="selected-placement-name">Arrange player</strong><div class="placement-control-row"><span>Avatar size</span><button id="placement-smaller" class="btn compact" type="button" aria-label="Make selected player smaller">Smaller</button><input id="placement-size" type="range" min="0.4" max="2.5" step="0.05" value="1" aria-label="Selected player size" /><output id="placement-size-output">100%</output><button id="placement-larger" class="btn compact" type="button" aria-label="Make selected player larger">Larger</button></div><div class="placement-control-row"><span>Name size</span><button id="name-smaller" class="btn compact" type="button" aria-label="Make selected name smaller">Smaller</button><input id="name-size" type="range" min="0.5" max="3" step="0.05" value="1" aria-label="Selected name size" /><output id="name-size-output">100%</output><button id="name-larger" class="btn compact" type="button" aria-label="Make selected name larger">Larger</button></div><div class="placement-name-position"><label for="name-position">Name position</label><select id="name-position" class="input">${namePositionOptions()}</select></div><p>Choose a name position, then drag the label for fine adjustment.</p></div>` : ""}
          <div id="live-preview" class="preview ${escapeHtml(session.background)} ${escapeHtml(session.layout)} ${customArrangement ? "custom-layout" : ""} ${placementEditing ? "placement-editing" : ""}">${players.length ? players.map(avatarMarkup).join("") : `<div class="empty">Share the player link to fill this room.</div>`}</div>
          <div class="game-strip"><span>Works with</span><strong>R.E.P.O.</strong><strong>PEAK</strong><strong>Meccha Chameleon</strong><strong>Any game</strong></div>
        </section>
        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2>Players</h2><p class="subtle">A player appears while their join page is open.</p></div><span class="badge">${players.length} ${players.length === 1 ? "PLAYER" : "PLAYERS"}</span></div>
            <div class="player-list">${players.length ? players.map((player) => `<div class="player-row">
              <div class="player-meta"><div class="player-name">${escapeHtml(player.name)}</div><div class="player-id">${player.mediaMode === "webcam" ? "Webcam and microphone" : player.source === "browser" ? "PNG and microphone" : player.source === "discord" ? "Discord call" : "Manual PNG"}</div></div>
              <div class="row-actions"><button class="icon-btn mic ${player.speaking ? "talking" : ""}" data-id="${escapeHtml(player.id)}" title="Test talking">◉</button><button class="icon-btn edit" data-id="${escapeHtml(player.id)}" title="Edit player">✎</button></div>
            </div>`).join("") : `<div class="empty">No players yet</div>`}</div>
          </section>
          <section class="card">
            <div class="card-head"><div><h2>Player join link</h2><p class="subtle">Send this to everyone who should appear.</p></div></div>
            <div class="copy-field"><input class="input mono" value="${escapeHtml(joinUrl)}" readonly /><button id="copy-join-2" class="btn">Copy</button></div>
            <p class="hint">Players keep this page open while playing. PNG mode sends speaking status only. Webcam mode also sends camera frames to this server.</p>
            <button class="btn ghost danger reset-link-button" type="button" data-reset-player-link>Reset player link for a new stream</button>
            <p class="hint">This removes invited guests and makes their old link stop working. Your OBS browser-source link stays unchanged.</p>
          </section>
          <section class="card">
            <div class="card-head"><div><h2>OBS browser source</h2><p class="subtle">Keep this different link private.</p></div></div>
            <div class="copy-field"><input class="input mono" value="${escapeHtml(overlayUrl)}" readonly /><button id="copy-overlay" class="btn">Copy</button></div>
            <p class="hint">Recommended size: 1920 × 1080. The background is transparent in OBS.</p>
            <div class="divider"></div>
            <div class="field"><label>Automatic layout</label><select id="layout" class="input">${customArrangement ? `<option value="" selected disabled>Custom arrangement</option>` : ""}<option value="row" ${!customArrangement && session.layout === "row" ? "selected" : ""}>Horizontal row</option><option value="arc" ${!customArrangement && session.layout === "arc" ? "selected" : ""}>Soft arc</option><option value="stack" ${!customArrangement && session.layout === "stack" ? "selected" : ""}>Vertical stack</option></select><span class="hint">Choosing one clears the custom arrangement and updates the OBS source.</span></div>
          </section>
        </div>
      </div></section>
      <section class="view-panel ${activeView === "players" ? "active" : ""}" data-panel="players">
        <div class="section-heading"><div><div class="eyebrow">Open invitation</div><h2>Player room</h2></div><button id="copy-join-room" class="btn primary">Copy invite link</button></div>
        <div class="room-callout"><div><span class="room-number">${session.onlineCount}</span><span>online now</span></div><p>Guests do not create accounts. They open your private link, choose PNG or webcam mode, and grant the required browser permissions.</p><button class="btn danger" type="button" data-reset-player-link>Reset player link for a new stream</button></div>
        <section class="card"><div class="card-head"><div><h2>Invitation link</h2><p class="subtle">Anyone with this link can join this overlay.</p></div></div><div class="copy-field"><input class="input mono" value="${escapeHtml(joinUrl)}" readonly /><button id="copy-join-room-2" class="btn">Copy</button></div></section>
        <section class="card room-list"><div class="card-head"><div><h2>Room roster</h2><p class="subtle">Connected guests appear automatically.</p></div><span class="badge">${players.length} TOTAL</span></div><div class="player-list">${players.length ? players.map((player) => `<div class="player-row"><div class="player-meta"><div class="player-name">${escapeHtml(player.name)}</div><div class="player-id">${player.source === "browser" ? "Guest browser" : player.source === "discord" ? "Discord call" : "Added by host"}</div></div><div class="row-actions"><button class="icon-btn edit" data-id="${escapeHtml(player.id)}" title="Edit player">✎</button></div></div>`).join("") : `<div class="empty">No players have joined yet.</div>`}</div></section>
      </section>
      <section class="view-panel ${activeView === "settings" ? "active" : ""}" data-panel="settings">
        <div class="section-heading"><div><div class="eyebrow">Host controls</div><h2>Settings</h2></div></div>
        <form id="settings-form" class="settings-grid">
          <section class="card stack"><div><h2>Room identity</h2><p class="subtle">Shown in the host dashboard and guest join page.</p></div><div class="field"><label>Room name</label><input class="input" name="name" value="${escapeHtml(session.name)}" maxlength="80" /></div></section>
          <section class="card stack"><div><h2>Overlay appearance</h2><p class="subtle">Choose how avatars and cameras are arranged in OBS.</p></div><div class="field"><label>Layout</label><select class="input" name="layout">${customArrangement ? `<option value="" selected disabled>Custom arrangement</option>` : ""}<option value="row" ${!customArrangement && session.layout === "row" ? "selected" : ""}>Horizontal row</option><option value="arc" ${!customArrangement && session.layout === "arc" ? "selected" : ""}>Soft arc</option><option value="stack" ${!customArrangement && session.layout === "stack" ? "selected" : ""}>Vertical stack</option></select><span class="hint">Choosing an automatic layout clears saved custom positions.</span></div><div class="field"><label>Preview background</label><select class="input" name="background"><option value="transparent" ${session.background === "transparent" ? "selected" : ""}>Transparent</option><option value="checker" ${session.background === "checker" ? "selected" : ""}>Checker</option><option value="dark" ${session.background === "dark" ? "selected" : ""}>Dark</option></select></div></section>
          <section class="card stack discord-card">
            <div><h2>Discord Activity call connector</h2><p class="subtle">Use Discord's own speaking events in direct calls, group DMs, and server calls. Launch PNGCalls from Discord's App Launcher while the call is active. No EXE, microphone threshold, or repeated pairing code is needed.</p></div>
            <div class="field"><label for="discord-callback">Website OAuth redirect</label><div class="copy-field"><input id="discord-callback" class="input mono" value="${escapeHtml(discordConnection?.callbackUrl || `${origin}/auth/discord/callback`)}" readonly /><button id="copy-discord-callback" class="btn" type="button">Copy</button></div><span class="hint">Keep this redirect for linking your host Discord account. For the Activity itself, Discord also requires the placeholder redirect https://127.0.0.1.</span></div>
            <div class="two-col"><div class="field"><label for="discord-client-id">Application client ID</label><input id="discord-client-id" class="input mono" inputmode="numeric" value="${escapeHtml(discordConnection?.clientId || "")}" placeholder="Discord client ID" /></div><div class="field"><label for="discord-client-secret">Client secret</label><input id="discord-client-secret" class="input" type="password" autocomplete="new-password" placeholder="${discordConnection?.configured ? "Leave blank to keep the saved secret" : "Discord client secret"}" /></div></div>
            <p class="hint">The client secret and Discord tokens are encrypted in SQLite and never sent to the browser. Add your Discord account under the application testers while developing RPC access.</p>
            ${discordConnection?.connected ? `<div class="connection-state"><span class="dot live"></span><span>Connected as <strong>${escapeHtml(discordConnection.connected.username)}</strong> and ready to verify the Activity</span></div>` : ""}
            <div class="discord-config-actions"><button id="save-discord-config" class="btn primary" type="button">Save Discord configuration</button>${discordConnection?.configured && !discordConnection?.connected ? `<a class="btn discord-btn" href="/auth/discord">Connect Discord account</a>` : ""}${discordConnection?.connected ? `<button id="disconnect-discord" class="btn ghost" type="button">Disconnect account</button>` : ""}${discordConnection?.source === "settings" ? `<button id="remove-discord-config" class="btn ghost danger" type="button">Remove configuration</button>` : ""}</div>
            <div class="companion-panel">
              <div><div class="eyebrow">DISCORD ACTIVITY</div><h3>${session.companion?.mode === "activity" && session.companion.online ? "Call detection is live" : "Launch inside your active call"}</h3><p class="subtle">${session.companion?.mode === "activity" && session.companion.channelName ? `Following ${escapeHtml(session.companion.channelName)} with Discord speaking events.` : "In the Developer Portal, enable Activities, map / to pngcalls.yarnobachmann.nl, and enable both User Install and Guild Install. Then launch PNGCalls from the Discord App Launcher in the DM or voice call."}</p></div>
              <div class="discord-config-actions">${discordConnection?.activityUrl ? `<a class="btn discord-btn" href="${escapeHtml(discordConnection.activityUrl)}" target="_blank" rel="noopener">Open PNGCalls in Discord</a>` : ""}</div>
              <div class="activity-artwork">
                <img class="activity-artwork-icon" src="/assets/discord/pngcalls-activity-icon.gif" alt="Animated PNGCalls Activity icon" />
                <div><strong>Discord artwork requires a manual portal upload</strong><p class="subtle">Upload the Zeph PNG under General Information as the App Icon. Upload the wall banner under Activities as the Activity Cover Image. Discord does not copy these files from PNGCalls automatically.</p><div class="discord-config-actions"><a class="btn ghost" href="/assets/discord/pngcalls-activity-icon.gif" download>Download image GIF</a><a class="btn ghost" href="/assets/discord/pngcalls-activity-icon.png" download>Download App Icon PNG</a><a class="btn ghost" href="/assets/discord/pngcalls-activity-banner.png" download>Download Activity Cover</a></div></div>
              </div>
              <details><summary>Windows EXE fallback</summary><p class="subtle">Use this only while the Activity is awaiting Discord approval or for troubleshooting. Pairing is saved after the first setup.</p><div class="discord-config-actions"><a class="btn ghost" href="${escapeHtml(discordConnection?.companionDownloadUrl || session.companion?.downloadUrl || "#")}" download>Download Windows EXE</a>${discordConnection?.connected && !discordConnection.connected.rpcReady ? `<a class="btn" href="/auth/discord/companion">Authorize EXE fallback</a>` : ""}${discordConnection?.connected?.rpcReady ? `<button id="pair-discord-companion" class="btn" type="button">${session.companion?.paired ? "Replace saved pairing" : "Create one-time pairing"}</button>` : ""}${session.companion?.paired ? `<button id="remove-discord-companion" class="btn ghost danger" type="button">Forget companion</button>` : ""}</div></details>
            </div>
          </section>
          <div class="settings-actions"><button class="btn primary" type="submit">Save settings</button><button id="sign-out" class="btn ghost" type="button">Sign out</button></div>
        </form>
      </section>
    </main>
  </div>`;

  const copyJoin = () => navigator.clipboard.writeText(joinUrl).then(() => toast("Player link copied"));
  document.querySelector("#copy-join").onclick = copyJoin;
  document.querySelector("#copy-join-2").onclick = copyJoin;
  document.querySelector("#copy-join-room").onclick = copyJoin;
  document.querySelector("#copy-join-room-2").onclick = copyJoin;
  document.querySelector("#copy-overlay").onclick = () => navigator.clipboard.writeText(overlayUrl).then(() => toast("OBS link copied"));
  bindPlacementEditor();
  connectDashboardWebcams();
  document.querySelectorAll("[data-reset-player-link]").forEach((button) => {
    button.onclick = async () => {
      if (!confirm("Create a new player link and remove all invited guests? The old player link will stop working. Your OBS browser source will stay the same.")) return;
      const resetButtons = [...document.querySelectorAll("[data-reset-player-link]")];
      resetButtons.forEach((resetButton) => { resetButton.disabled = true; });
      try {
        session = await api(`/api/sessions/${session.id}/reset-join`, { method: "POST" });
        toast("New player link ready. The OBS link did not change.");
        renderDashboard();
      } catch (error) {
        resetButtons.forEach((resetButton) => { resetButton.disabled = false; });
        toast(error.message);
      }
    };
  });
  document.querySelector("#add-player").onclick = () => showPlayerModal();
  document.querySelectorAll(".edit").forEach((button) => button.onclick = () => showPlayerModal(players.find((player) => player.id === button.dataset.id)));
  document.querySelectorAll(".mic").forEach((button) => {
    const setSpeaking = async (speaking) => api(`/api/sessions/${session.id}/manual/${encodeURIComponent(button.dataset.id)}`, { method: "POST", body: JSON.stringify({ speaking }) });
    button.onpointerdown = () => setSpeaking(true);
    button.onpointerup = button.onpointerleave = () => setSpeaking(false);
  });
  document.querySelector("#layout").onchange = async (event) => {
    event.target.disabled = true;
    try { await chooseAutomaticLayout(event.target.value); }
    catch (error) { event.target.disabled = false; toast(error.message); }
  };
  document.querySelectorAll("[data-view]").forEach((button) => button.onclick = () => {
    activeView = button.dataset.view;
    renderDashboard();
  });
  document.querySelector("#settings-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const secrets = { joinToken: session.joinToken, overlayToken: session.overlayToken };
    const chosenLayout = form.get("layout");
    const nextLayout = chosenLayout || session.layout;
    if (chosenLayout && (customArrangement || nextLayout !== session.layout)) await api(`/api/sessions/${session.id}/placements`, { method: "PUT", body: JSON.stringify({ reset: true }) });
    session = await api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ name: form.get("name"), layout: nextLayout, background: form.get("background") }) });
    Object.assign(session, secrets);
    toast("Settings saved");
    renderDashboard();
  };
  document.querySelector("#sign-out").onclick = async () => {
    await api("/api/auth/logout", { method: "POST" });
    await initializeHost();
  };
  document.querySelector("#copy-discord-callback").onclick = () => navigator.clipboard.writeText(document.querySelector("#discord-callback").value).then(() => toast("Discord redirect URL copied"));
  document.querySelector("#save-discord-config").onclick = async () => {
    const button = document.querySelector("#save-discord-config");
    button.disabled = true;
    try {
      await api("/api/discord/config", { method: "POST", body: JSON.stringify({ clientId: document.querySelector("#discord-client-id").value, clientSecret: document.querySelector("#discord-client-secret").value }) });
      discordConnection = await api("/api/discord/status");
      toast("Discord configuration saved");
      renderDashboard();
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  };
  document.querySelector("#disconnect-discord")?.addEventListener("click", async () => {
    await api("/api/discord/disconnect", { method: "POST" });
    discordConnection = await api("/api/discord/status");
    toast("Discord disconnected");
    renderDashboard();
  });
  document.querySelector("#remove-discord-config")?.addEventListener("click", async () => {
    if (!confirm("Remove the saved Discord configuration and disconnect the account?")) return;
    await api("/api/discord/config", { method: "DELETE" });
    discordConnection = await api("/api/discord/status");
    toast("Discord configuration removed");
    renderDashboard();
  });
  document.querySelector("#pair-discord-companion")?.addEventListener("click", async () => {
    const result = await api(`/api/sessions/${session.id}/discord-companion/pair`, { method: "POST" });
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `<section class="modal-card pairing-modal" role="dialog" aria-modal="true" aria-labelledby="pairing-title"><h2 id="pairing-title">Pair the Windows companion</h2><ol><li>Download and open PNGCalls-Companion.exe.</li><li>Enter <strong>${escapeHtml(origin)}</strong> as the PNGCalls address.</li><li>Paste the pairing code below. It is replaced whenever you create a new one.</li></ol><div class="copy-field"><input id="companion-pairing-code" class="input mono" value="${escapeHtml(result.pairingCode)}" readonly /><button id="copy-companion-code" class="btn primary" type="button">Copy code</button></div><p class="hint">Windows may warn that this unsigned personal application is not commonly downloaded. The source and build workflow are included in this repository.</p><div class="actions"><a class="btn ghost" href="${escapeHtml(result.downloadUrl)}" download>Download EXE</a><button id="close-pairing" class="btn" type="button">Done</button></div></section>`;
    document.body.append(modal);
    modal.querySelector("#copy-companion-code").onclick = () => navigator.clipboard.writeText(result.pairingCode).then(() => toast("Pairing code copied"));
    modal.querySelector("#close-pairing").onclick = () => { modal.remove(); loadDashboard(); };
  });
  document.querySelector("#remove-discord-companion")?.addEventListener("click", async () => {
    if (!confirm("Forget this companion and stop importing the current Discord call?")) return;
    await api(`/api/sessions/${session.id}/discord-companion/pair`, { method: "DELETE" });
    toast("Discord companion forgotten");
    await loadDashboard();
  });
}

function showPlayerModal(player = null) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<form class="modal-card" id="player-form">
    <h2>${player ? "Edit player" : "Add player"}</h2>
    <div class="field"><label>Stable player ID</label><input name="id" class="input mono" required value="${escapeHtml(player?.id || "")}" ${player ? "readonly" : ""} placeholder="player-name" /></div>
    <div class="field"><label>Display name</label><input name="name" class="input" required value="${escapeHtml(player?.name || "")}" placeholder="Player name" /></div>
    <div class="field"><label>Name font</label><select name="nameFont" class="input font-choice font-${normalizeNameFont(player?.nameFont)}">${nameFontOptions(normalizeNameFont(player?.nameFont))}</select></div>
    <div class="field"><label>Name position</label><select name="namePosition" class="input">${namePositionOptions()}</select><span class="hint">Choose a preset here, then fine tune it by dragging the name in Arrange players.</span></div>
    <div class="two-col"><div class="field"><label>Name background</label><select name="nameBackground" class="input"><option value="solid" ${player?.nameBackground !== "none" ? "selected" : ""}>Background color</option><option value="none" ${player?.nameBackground === "none" ? "selected" : ""}>No background</option></select></div><div class="field"><label>Background color</label><input name="nameBackgroundColor" class="input" type="color" value="${escapeHtml(player?.nameBackgroundColor || "#090305")}" /></div></div>
    <div class="two-col"><div class="field"><label>Idle image</label><input name="idle" class="input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" /></div><div class="field"><label>Talking image</label><input name="talking" class="input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" /></div></div>
    ${player?.source === "discord" ? `<label class="check-row"><input name="useDiscordAvatar" type="checkbox" ${player.useDiscordAvatar !== false ? "checked" : ""} /><span>Use this person's Discord profile picture when no custom image is set</span></label>` : ""}
    <div class="field"><label>Speaking accent</label><input name="accent" class="input" type="color" value="${escapeHtml(player?.accent || "#d0193c")}" /><span class="hint">Used for the name outline, webcam border, and glow while speaking.</span></div>
    <div class="animation-controls"><label class="check-row"><input id="animate-speaking" name="animateSpeaking" type="checkbox" ${player?.speakingAnimation && player.speakingAnimation !== "none" ? "checked" : ""} /><span>Animate while speaking</span></label><div class="field"><label for="speaking-animation">Animation style</label><select id="speaking-animation" name="speakingAnimation" class="input"><option value="bounce" ${player?.speakingAnimation === "bounce" ? "selected" : ""}>Bounce</option><option value="pulse" ${player?.speakingAnimation === "pulse" ? "selected" : ""}>Pulse</option><option value="shake" ${player?.speakingAnimation === "shake" ? "selected" : ""}>Shake</option><option value="glow" ${player?.speakingAnimation === "glow" ? "selected" : ""}>Glow</option></select></div></div>
    <div class="actions"><button class="btn primary" type="submit">Save player</button><button class="btn ghost" type="button" id="cancel-modal">Cancel</button>${player ? `<button class="btn ghost danger" type="button" id="delete-player">Remove</button>` : ""}</div>
  </form>`;
  document.body.append(modal);
  document.querySelector("#cancel-modal").onclick = () => modal.remove();
  const animationToggle = document.querySelector("#animate-speaking");
  const animationSelect = document.querySelector("#speaking-animation");
  const syncAnimationControl = () => { animationSelect.disabled = !animationToggle.checked; };
  animationToggle.onchange = syncAnimationControl;
  syncAnimationControl();
  modal.addEventListener("click", (event) => { if (event.target === modal) modal.remove(); });
  document.querySelector("#player-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = form.get("id");
    const positionPreset = namePositionPresets[form.get("namePosition")];
    await api(`/api/sessions/${session.id}/players/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name: form.get("name"), nameFont: form.get("nameFont"), nameBackground: form.get("nameBackground"), nameBackgroundColor: form.get("nameBackgroundColor"), ...(positionPreset ? { nameOffsetX: positionPreset.x, nameOffsetY: positionPreset.y } : {}), accent: form.get("accent"), pinned: true, speakingAnimation: form.get("animateSpeaking") ? form.get("speakingAnimation") : "none", ...(player?.source === "discord" ? { useDiscordAvatar: Boolean(form.get("useDiscordAvatar")) } : {}) }) });
    if (form.get("idle")?.size || form.get("talking")?.size) {
      const images = new FormData();
      if (form.get("idle")?.size) images.append("idle", form.get("idle"));
      if (form.get("talking")?.size) images.append("talking", form.get("talking"));
      await api(`/api/sessions/${session.id}/players/${encodeURIComponent(id)}/images`, { method: "POST", body: images });
    }
    modal.remove();
    await loadDashboard();
  };
  if (player) document.querySelector("#delete-player").onclick = async () => {
    await api(`/api/sessions/${session.id}/players/${encodeURIComponent(player.id)}`, { method: "DELETE" });
    modal.remove();
    await loadDashboard();
  };
}

async function loadDashboard() {
  try {
    session = await api(`/api/sessions/${sessionId}`);
    discordConnection = await api("/api/discord/status").catch(() => ({ configured: false, connected: null }));
    renderDashboard();
    startDashboardLive();
  } catch {
    localStorage.removeItem("pngcalls.sessionId");
    localStorage.removeItem("relay.sessionId");
    sessionId = null;
    await initializeHost();
  }
}

async function initializeHost() {
  const auth = await api("/api/auth/status");
  csrfToken = auth.csrfToken;
  if (!auth.authenticated) {
    renderAuth(auth.needsSetup);
    return;
  }
  const rooms = await api("/api/sessions");
  const selected = rooms.find((room) => room.id === sessionId) || rooms[0];
  if (!selected) {
    renderWelcome();
    return;
  }
  sessionId = selected.id;
  localStorage.setItem("pngcalls.sessionId", sessionId);
  await loadDashboard();
}

async function runJoin() {
  const [, id, joinToken] = pathParts;
  const storageKey = `pngcalls.join.${id}`;
  let identity = JSON.parse(localStorage.getItem(storageKey) || "null");
  let cameraPreviewStream = null;
  let cropPreviewAnimation = 0;

  const stopCameraPreview = () => {
    cancelAnimationFrame(cropPreviewAnimation);
    cropPreviewAnimation = 0;
    cameraPreviewStream?.getTracks().forEach((track) => track.stop());
    cameraPreviewStream = null;
  };

  const renderForm = () => {
    app.innerHTML = `<main class="join-page">
      ${studioShelfMarkup("join-studio-shelf")}
      <section class="join-card">
        ${brandMarkup()}
        <div class="eyebrow">Player setup</div>
        <h1>Join the overlay</h1>
        <p class="join-copy">Choose PNG images or a webcam. Microphone audio stays on this device. Webcam mode sends camera frames only to this PNGCalls server.</p>
        <form id="join-form" class="stack">
          <div class="field"><label>Display name</label><input class="input" name="name" required maxlength="60" placeholder="Your name" /></div>
          <div class="field"><label for="name-font">Name font</label><select id="name-font" class="input font-choice font-rounded" name="nameFont">${nameFontOptions()}</select><span id="font-preview" class="font-preview font-rounded">Your name will look like this</span></div>
          <div class="field"><label>Appearance</label><select id="media-mode" class="input" name="mediaMode"><option value="png">PNG images</option><option value="webcam">Webcam</option></select></div>
          <div id="png-fields" class="two-col"><div class="field"><label>Idle image</label><input class="input" name="idle" type="file" required accept="image/png,image/jpeg,image/webp,image/gif" /></div><div class="field"><label>Talking image</label><input class="input" name="talking" type="file" required accept="image/png,image/jpeg,image/webp,image/gif" /></div></div>
          <section id="camera-fields" class="camera-picker" hidden>
            <div class="field"><label for="camera-device">Camera source</label><div class="camera-actions"><select id="camera-device" class="input" name="cameraDeviceId" disabled><option value="">Find cameras first</option></select><button id="find-cameras" class="btn ghost" type="button">Find cameras</button></div></div>
            <div class="field"><label for="camera-fps">Frame rate</label><select id="camera-fps" class="input" name="cameraFps"><option value="30" selected>30 FPS</option><option value="60">60 FPS</option></select></div>
            <video id="camera-test-preview" autoplay muted playsinline hidden></video>
            <canvas id="crop-test-preview" class="camera-preview" width="640" height="360" hidden></canvas>
            ${cropControlsMarkup(true)}
            <p id="camera-status" class="hint">Start OBS Virtual Camera, then press Find cameras. If the default camera is busy, you can still choose another detected source.</p>
          </section>
          <p id="webcam-note" class="hint" hidden>Choose 30 FPS for normal use or 60 FPS for smoother motion. PNGCalls streams the latest frame and does not make a video recording.</p>
          <div class="field"><label>Speaking accent</label><input class="input" name="accent" type="color" value="#d0193c" /><span class="hint">Used for the name outline, webcam border, and glow while speaking.</span></div>
          <div class="animation-controls"><label class="check-row"><input id="animate-speaking" name="animateSpeaking" type="checkbox" /><span>Animate while speaking</span></label><div class="field"><label for="speaking-animation">Animation style</label><select id="speaking-animation" name="speakingAnimation" class="input" disabled><option value="bounce">Bounce</option><option value="pulse">Pulse</option><option value="shake">Shake</option><option value="glow">Glow</option></select></div></div>
          <button class="btn primary" type="submit">Join and enable microphone</button>
        </form>
      </section>
    </main>`;
    const modeSelect = document.querySelector("#media-mode");
    const nameInput = document.querySelector("input[name='name']");
    const nameFontSelect = document.querySelector("#name-font");
    const fontPreview = document.querySelector("#font-preview");
    const syncFontPreview = () => {
      nameFontSelect.className = `input font-choice font-${normalizeNameFont(nameFontSelect.value)}`;
      fontPreview.className = `font-preview font-${normalizeNameFont(nameFontSelect.value)}`;
      fontPreview.textContent = nameInput.value.trim() || "Your name will look like this";
    };
    nameFontSelect.onchange = syncFontPreview;
    nameInput.oninput = syncFontPreview;
    syncFontPreview();
    const syncMode = () => {
      const webcam = modeSelect.value === "webcam";
      document.querySelector("#png-fields").hidden = webcam;
      document.querySelector("#camera-fields").hidden = !webcam;
      document.querySelector("#webcam-note").hidden = !webcam;
      document.querySelectorAll("#png-fields input").forEach((input) => { input.required = !webcam; });
      if (!webcam) stopCameraPreview();
    };
    modeSelect.onchange = syncMode;
    syncMode();
    const animationToggle = document.querySelector("#animate-speaking");
    const animationSelect = document.querySelector("#speaking-animation");
    animationToggle.onchange = () => { animationSelect.disabled = !animationToggle.checked; };
    const cameraSelect = document.querySelector("#camera-device");
    const cameraStatus = document.querySelector("#camera-status");
    const cameraPreview = document.querySelector("#camera-test-preview");
    const cropPreview = document.querySelector("#crop-test-preview");
    const cropControls = document.querySelector("#crop-controls");
    const currentCrop = bindCropControls();
    const renderCropPreview = () => {
      drawCroppedFrame(cameraPreview, cropPreview, currentCrop());
      cropPreviewAnimation = requestAnimationFrame(renderCropPreview);
    };
    const openCameraPreview = async (deviceId = "") => {
      stopCameraPreview();
      const video = deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 360 } } : true;
      cameraPreviewStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      cameraPreview.srcObject = cameraPreviewStream;
      await cameraPreview.play().catch(() => {});
      cropPreview.hidden = false;
      cropControls.hidden = false;
      renderCropPreview();
    };
    document.querySelector("#find-cameras").onclick = async () => {
      cameraStatus.textContent = "Requesting camera access...";
      let previewError = null;
      try {
        await openCameraPreview(cameraSelect.value);
      } catch (error) {
        previewError = error;
        stopCameraPreview();
        cropPreview.hidden = true;
        cropControls.hidden = true;
      }
      try {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
        const activeDevice = cameraPreviewStream?.getVideoTracks()[0]?.getSettings().deviceId || "";
        cameraSelect.innerHTML = devices.length
          ? `${activeDevice ? "" : `<option value="" selected disabled>Choose an available camera</option>`}${devices.map((device, index) => `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === activeDevice ? "selected" : ""}>${escapeHtml(device.label || `Camera ${index + 1}`)}</option>`).join("")}`
          : `<option value="">No cameras found</option>`;
        cameraSelect.disabled = !devices.length;
        cameraStatus.textContent = devices.length
          ? previewError ? `${devices.length} camera source${devices.length === 1 ? "" : "s"} found. The default camera is unavailable, so choose another source from the list.` : `${devices.length} camera source${devices.length === 1 ? "" : "s"} found and ready.`
          : "No camera sources were found.";
      } catch (error) {
        stopCameraPreview();
        cropPreview.hidden = true;
        cropControls.hidden = true;
        cameraStatus.textContent = `Camera access failed: ${error.message}`;
      }
    };
    cameraSelect.onchange = async () => {
      try {
        await openCameraPreview(cameraSelect.value);
        cameraStatus.textContent = "Camera source ready.";
      } catch (error) {
        cropPreview.hidden = true;
        cropControls.hidden = true;
        cameraStatus.textContent = `Could not open this camera: ${error.message}`;
      }
    };
    document.querySelector("#join-form").onsubmit = async (event) => {
      event.preventDefault();
      const submit = event.submitter;
      submit.disabled = true;
      submit.textContent = "Joining...";
      try {
        const form = new FormData(event.currentTarget);
        const mediaMode = form.get("mediaMode");
        const speakingAnimation = form.get("animateSpeaking") ? form.get("speakingAnimation") : "none";
        const joined = await api(`/api/join/${id}/${joinToken}`, { method: "POST", body: JSON.stringify({ name: form.get("name"), nameFont: normalizeNameFont(form.get("nameFont")), accent: form.get("accent"), mediaMode, speakingAnimation }) });
        identity = {
          playerId: joined.playerId,
          name: form.get("name"),
          nameFont: normalizeNameFont(form.get("nameFont")),
          mediaMode,
          cameraDeviceId: mediaMode === "webcam" ? form.get("cameraDeviceId") || "" : "",
          cameraFps: mediaMode === "webcam" && form.get("cameraFps") === "60" ? 60 : 30,
          crop: mediaMode === "webcam" ? normalizeCrop({ zoom: form.get("cropZoom"), x: form.get("cropX"), y: form.get("cropY") }) : normalizeCrop(),
        };
        localStorage.setItem(storageKey, JSON.stringify(identity));
        if (mediaMode === "png") {
          const images = new FormData();
          images.append("idle", form.get("idle"));
          images.append("talking", form.get("talking"));
          await api(`/api/join/${id}/${joinToken}/${identity.playerId}/images`, { method: "POST", body: images });
        }
        stopCameraPreview();
        await startMic(id, joinToken, identity, storageKey);
      } catch (error) {
        stopCameraPreview();
        submit.disabled = false;
        submit.textContent = "Join and enable microphone";
        toast(error.message);
      }
    };
  };

  if (!identity) return renderForm();
  try {
    const resumed = await api(`/api/join/${id}/${joinToken}`, { method: "POST", body: JSON.stringify({ playerId: identity.playerId }) });
    identity.mediaMode = resumed.player?.mediaMode || identity.mediaMode || "png";
    identity.nameFont = normalizeNameFont(resumed.player?.nameFont || identity.nameFont);
    identity.cameraFps = identity.cameraFps === 60 ? 60 : 30;
    identity.crop = normalizeCrop(identity.crop);
    localStorage.setItem(storageKey, JSON.stringify(identity));
    await startMic(id, joinToken, identity, storageKey);
  } catch {
    localStorage.removeItem(storageKey);
    identity = null;
    renderForm();
  }
}

async function startMic(id, joinToken, identity, storageKey) {
  const useWebcam = identity.mediaMode === "webcam";
  app.innerHTML = `<main class="join-page">${studioShelfMarkup("join-studio-shelf")}<section class="join-card active-mic">
    ${brandMarkup()}
    <div class="eyebrow">Connected as ${escapeHtml(identity.name)}</div>
    <h1>Keep this tab open</h1>
    <p class="join-copy">${useWebcam ? "Your camera frames go to this PNGCalls server while this tab stays open." : "You can minimize this window. Only your speaking status is sent to the overlay."}</p>
    ${useWebcam ? `<video id="camera-preview" autoplay muted playsinline hidden></video><canvas id="camera-output-preview" class="camera-preview" width="640" height="360"></canvas><div class="field"><label for="live-camera-fps">Frame rate</label><select id="live-camera-fps" class="input"><option value="30" ${identity.cameraFps === 60 ? "" : "selected"}>30 FPS</option><option value="60" ${identity.cameraFps === 60 ? "selected" : ""}>60 FPS</option></select></div>${cropControlsMarkup()}` : ""}
    <div class="meter"><span id="meter-bar"></span></div>
    <div class="mic-state"><span class="dot live"></span><strong id="mic-label">Listening for your voice</strong></div>
    <button id="leave-room" class="btn ghost">Forget this room</button>
  </section></main>`;

  let leaving = false;
  document.querySelector("#leave-room").onclick = async () => {
    leaving = true;
    document.querySelector("#leave-room").disabled = true;
    await api(`/api/join/${id}/${joinToken}/${identity.playerId}/leave`, { method: "POST" }).catch(() => {});
    localStorage.removeItem(storageKey);
    location.reload();
  };

  let speaking = false;
  const heartbeat = () => leaving ? Promise.resolve() : api(`/api/join/${id}/${joinToken}/${identity.playerId}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({ speaking }),
  }).catch(() => {});
  heartbeat();
  setInterval(heartbeat, 500);

  const requestedFps = identity.cameraFps === 60 ? 60 : 30;
  let stream;
  try {
    const camera = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: requestedFps, max: requestedFps } };
    if (identity.cameraDeviceId) camera.deviceId = { exact: identity.cameraDeviceId };
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: useWebcam ? camera : false,
    });
  } catch (error) {
    if (useWebcam && identity.cameraDeviceId && ["OverconstrainedError", "NotFoundError"].includes(error.name)) {
      identity.cameraDeviceId = "";
      localStorage.setItem(storageKey, JSON.stringify(identity));
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: requestedFps, max: requestedFps } },
        });
      } catch {}
    }
  }
  if (!stream) {
    document.querySelector("#mic-label").textContent = useWebcam ? "Camera and microphone access are required" : "Microphone access is required";
    document.querySelector(".dot").classList.remove("live");
    return;
  }

  if (useWebcam) {
    const video = document.querySelector("#camera-preview");
    const canvas = document.querySelector("#camera-output-preview");
    video.srcObject = stream;
    await video.play().catch(() => {});
    canvas.width = 640;
    canvas.height = 360;
    let crop = normalizeCrop(identity.crop);
    bindCropControls(crop, (value) => {
      crop = value;
      identity.crop = value;
      localStorage.setItem(storageKey, JSON.stringify(identity));
    });
    const drawPreview = () => {
      drawCroppedFrame(video, canvas, crop);
      requestAnimationFrame(drawPreview);
    };
    drawPreview();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let cameraSocket;
    const connectPublisher = () => {
      cameraSocket = new WebSocket(`${protocol}//${location.host}/ws/publish/${encodeURIComponent(id)}/${encodeURIComponent(joinToken)}/${encodeURIComponent(identity.playerId)}`);
      cameraSocket.onclose = () => { if (!leaving) setTimeout(connectPublisher, 1500); };
    };
    connectPublisher();
    let sendingFrame = false;
    let fallbackSentAt = 0;
    let frameTimer;
    const captureFrame = () => {
      if (sendingFrame || video.readyState < 2) return;
      sendingFrame = true;
      canvas.toBlob(async (blob) => {
        try {
          if (blob && cameraSocket?.readyState === WebSocket.OPEN && cameraSocket.bufferedAmount < 1024 * 1024) cameraSocket.send(blob);
          else if (blob && Date.now() - fallbackSentAt > 250) {
            fallbackSentAt = Date.now();
            await api(`/api/join/${id}/${joinToken}/${identity.playerId}/webcam-frame`, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob });
          }
        } catch {}
        sendingFrame = false;
      }, "image/jpeg", 0.68);
    };
    const setFrameRate = async (fps) => {
      clearInterval(frameTimer);
      identity.cameraFps = fps === 60 ? 60 : 30;
      localStorage.setItem(storageKey, JSON.stringify(identity));
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack?.applyConstraints) {
        await videoTrack.applyConstraints({ frameRate: { ideal: identity.cameraFps, max: identity.cameraFps } }).catch(() => {});
      }
      frameTimer = setInterval(captureFrame, 1000 / identity.cameraFps);
    };
    const fpsSelect = document.querySelector("#live-camera-fps");
    fpsSelect.onchange = () => { setFrameRate(Number(fpsSelect.value)); };
    await setFrameRate(identity.cameraFps);
  }

  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.45;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let silenceFrames = 0;

  const measure = () => {
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const value of samples) energy += value * value;
    const level = Math.sqrt(energy / samples.length);
    const detected = level > 0.035;
    silenceFrames = detected ? 0 : silenceFrames + 1;
    speaking = detected || (speaking && silenceFrames < 10);
    document.querySelector("#meter-bar").style.transform = `scaleX(${Math.min(1, level * 12)})`;
    document.querySelector("#mic-label").textContent = speaking ? "Speaking" : "Listening for your voice";
  };
  measure();
  setInterval(measure, 80);
}

async function runOverlay() {
  document.body.className = "overlay-page";
  const [, id, overlayToken] = pathParts;
  let playerStructure = "";
  const render = (data) => {
    document.documentElement.style.background = "transparent";
    const nextStructure = playerSignature(data.players);
    let stage = app.querySelector(".overlay-stage");
    if (!stage || nextStructure !== playerStructure) {
      app.querySelectorAll("img[data-webcam-src]").forEach((image) => { image.webcamSocket?.close(); if (image.dataset.webcamBlob) URL.revokeObjectURL(image.dataset.webcamBlob); });
      app.innerHTML = `<main class="overlay-stage ${escapeHtml(data.layout)} ${hasCustomPlacement(data.players) ? "custom-layout" : ""}">${data.players.map(avatarMarkup).join("")}</main>`;
      playerStructure = nextStructure;
      stage = app.querySelector(".overlay-stage");
    }
    stage.className = `overlay-stage ${data.layout} ${hasCustomPlacement(data.players) ? "custom-layout" : ""}`;
    [...stage.querySelectorAll(".avatar")].forEach((avatar, index) => {
      const player = data.players[index];
      applyPlayerState(avatar, player);
    });
    stage.querySelectorAll("img[data-webcam-src]").forEach((image) => connectWebcamStream(image, id, overlayToken, image.closest(".avatar").dataset.playerId));
  };
  let pollBusy = false;
  let stateSocket;
  const refresh = async () => {
    if (pollBusy) return;
    pollBusy = true;
    try { render(await api(`/api/overlay/${id}/${overlayToken}?now=${Date.now()}`)); }
    finally { pollBusy = false; }
  };
  try {
    await refresh();
    const connectState = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      stateSocket = new WebSocket(`${protocol}//${location.host}/ws/overlay/${encodeURIComponent(id)}/${encodeURIComponent(overlayToken)}`);
      stateSocket.onmessage = (event) => {
        try { render(JSON.parse(String(event.data))); } catch {}
      };
      stateSocket.onclose = () => setTimeout(connectState, 1000);
    };
    connectState();
    setInterval(() => refresh().catch(() => {}), 2000);
  } catch {
    app.innerHTML = "";
  }
}

if (isOverlay) runOverlay();
else if (isJoin) runJoin();
else initializeHost();
if (!isOverlay) setTimeout(mountTutorialHelper, 700);
