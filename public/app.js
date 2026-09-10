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

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value)));
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
  const image = isWebcam ? player.webcamImage : player.speaking ? player.talkingImage || player.idleImage : player.idleImage;
  const animation = ["bounce", "pulse", "shake", "glow"].includes(player.speakingAnimation) ? player.speakingAnimation : "none";
  return `<article class="avatar ${isWebcam ? "webcam" : ""} ${player.speaking ? "speaking" : ""} animation-${animation}" data-player-id="${escapeHtml(player.id)}" style="--accent:${escapeHtml(player.accent)}">
    ${image ? `<img class="avatar-img ${isWebcam ? "webcam-img" : ""}" src="${escapeHtml(image)}${isWebcam ? `?v=${Date.now()}` : ""}" ${isWebcam ? `data-webcam-src="${escapeHtml(image)}"` : ""} alt="${isWebcam ? `${escapeHtml(player.name)} webcam` : ""}" />` : `<div class="avatar-fallback"><span>${isWebcam ? "CAMERA" : player.speaking ? "TALK" : "IDLE"}</span></div>`}
    <div class="avatar-name">${escapeHtml(player.name)}</div>
  </article>`;
}

setInterval(() => {
  document.querySelectorAll("img[data-webcam-src]").forEach((image) => {
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
}, 350);

async function api(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const securityHeaders = csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method) ? { "X-CSRF-Token": csrfToken } : {};
  const response = await fetch(url, {
    ...options,
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

function brandMarkup() {
  return `<div class="brand"><img class="brand-gif" src="/assets/zeph.gif" alt="Zephikyu" /><span>Zephikyu <i>PNGCalls</i></span></div>`;
}

function renderAuth(needsSetup) {
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
  app.innerHTML = `<main class="welcome">
    <section class="welcome-copy">
      <div class="eyebrow">Zephikyu · Self-hosted · OBS ready</div>
      <h1>Awaken your crew<span class="slash">.</span></h1>
      <p>Give every player a speaking-aware avatar or webcam without game mods. Invite links work on their own, and Discord connection is optional.</p>
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

function renderDashboard() {
  const origin = location.origin;
  const overlayUrl = `${origin}/overlay/${session.id}/${session.overlayToken}`;
  const joinUrl = `${origin}/join/${session.id}/${session.joinToken}`;
  const players = session.players || [];
  app.innerHTML = `<div class="shell">
    <aside class="rail">
      ${brandMarkup()}
      <nav class="nav" aria-label="Dashboard"><button class="nav-item ${activeView === "overlay" ? "active" : ""}" data-view="overlay">◫ Overlay</button><button class="nav-item ${activeView === "players" ? "active" : ""}" data-view="players">⌁ Player room</button><button class="nav-item ${activeView === "settings" ? "active" : ""}" data-view="settings">⚙ Settings</button></nav>
      <div class="rail-note"><div class="status-line"><span class="dot ${session.onlineCount ? "live" : ""}"></span>${session.onlineCount ? `${session.onlineCount} connected` : "Waiting for players"}</div>Invite links work alone. Discord is optional.</div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div><div class="eyebrow">Overlay workspace</div><h1>${escapeHtml(session.name)}</h1></div>
        <div class="actions"><button id="copy-join" class="btn ghost">Copy player link</button><button id="add-player" class="btn primary">Add manually</button></div>
      </header>
      <section class="view-panel ${activeView === "overlay" ? "active" : ""}" data-panel="overlay"><div class="grid">
        <section class="card">
          <div class="card-head"><div><h2>Live preview</h2><p class="subtle">Connected browsers can show PNGs or webcam frames.</p></div><span class="badge ${session.onlineCount ? "live" : ""}">${session.onlineCount ? `${session.onlineCount} ONLINE` : "PREVIEW"}</span></div>
          <div class="preview ${escapeHtml(session.background)}">${players.length ? players.map(avatarMarkup).join("") : `<div class="empty">Share the player link to fill this room.</div>`}</div>
          <div class="game-strip"><span>Works with</span><strong>R.E.P.O.</strong><strong>PEAK</strong><strong>Meccha Chameleon</strong><strong>Any game</strong></div>
        </section>
        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2>Players</h2><p class="subtle">A player appears while their join page is open.</p></div><span class="badge">${players.length} ${players.length === 1 ? "PLAYER" : "PLAYERS"}</span></div>
            <div class="player-list">${players.length ? players.map((player) => `<div class="player-row">
              <div class="player-meta"><div class="player-name">${escapeHtml(player.name)}</div><div class="player-id">${player.mediaMode === "webcam" ? "Webcam and microphone" : player.source === "browser" ? "PNG and microphone" : "Manual PNG"}</div></div>
              <div class="row-actions"><button class="icon-btn mic ${player.speaking ? "talking" : ""}" data-id="${escapeHtml(player.id)}" title="Test talking">◉</button><button class="icon-btn edit" data-id="${escapeHtml(player.id)}" title="Edit player">✎</button></div>
            </div>`).join("") : `<div class="empty">No players yet</div>`}</div>
          </section>
          <section class="card">
            <div class="card-head"><div><h2>Player join link</h2><p class="subtle">Send this to everyone who should appear.</p></div></div>
            <div class="copy-field"><input class="input mono" value="${escapeHtml(joinUrl)}" readonly /><button id="copy-join-2" class="btn">Copy</button></div>
            <p class="hint">Players keep this page open while playing. PNG mode sends speaking status only. Webcam mode also sends camera frames to this server.</p>
          </section>
          <section class="card">
            <div class="card-head"><div><h2>OBS browser source</h2><p class="subtle">Keep this different link private.</p></div></div>
            <div class="copy-field"><input class="input mono" value="${escapeHtml(overlayUrl)}" readonly /><button id="copy-overlay" class="btn">Copy</button></div>
            <p class="hint">Recommended size: 1920 × 1080. The background is transparent in OBS.</p>
            <div class="divider"></div>
            <div class="field"><label>Layout</label><select id="layout" class="input"><option value="row" ${session.layout === "row" ? "selected" : ""}>Horizontal row</option><option value="arc" ${session.layout === "arc" ? "selected" : ""}>Soft arc</option><option value="stack" ${session.layout === "stack" ? "selected" : ""}>Vertical stack</option></select></div>
          </section>
        </div>
      </div></section>
      <section class="view-panel ${activeView === "players" ? "active" : ""}" data-panel="players">
        <div class="section-heading"><div><div class="eyebrow">Open invitation</div><h2>Player room</h2></div><button id="copy-join-room" class="btn primary">Copy invite link</button></div>
        <div class="room-callout"><div><span class="room-number">${session.onlineCount}</span><span>online now</span></div><p>Guests do not create accounts. They open your private link, choose PNG or webcam mode, and grant the required browser permissions.</p></div>
        <section class="card"><div class="card-head"><div><h2>Invitation link</h2><p class="subtle">Anyone with this link can join this overlay.</p></div></div><div class="copy-field"><input class="input mono" value="${escapeHtml(joinUrl)}" readonly /><button id="copy-join-room-2" class="btn">Copy</button></div></section>
        <section class="card room-list"><div class="card-head"><div><h2>Room roster</h2><p class="subtle">Connected guests appear automatically.</p></div><span class="badge">${players.length} TOTAL</span></div><div class="player-list">${players.length ? players.map((player) => `<div class="player-row"><div class="player-meta"><div class="player-name">${escapeHtml(player.name)}</div><div class="player-id">${player.source === "browser" ? "Guest browser" : "Added by host"}</div></div><div class="row-actions"><button class="icon-btn edit" data-id="${escapeHtml(player.id)}" title="Edit player">✎</button></div></div>`).join("") : `<div class="empty">No players have joined yet.</div>`}</div></section>
      </section>
      <section class="view-panel ${activeView === "settings" ? "active" : ""}" data-panel="settings">
        <div class="section-heading"><div><div class="eyebrow">Host controls</div><h2>Settings</h2></div></div>
        <form id="settings-form" class="settings-grid">
          <section class="card stack"><div><h2>Room identity</h2><p class="subtle">Shown in the host dashboard and guest join page.</p></div><div class="field"><label>Room name</label><input class="input" name="name" value="${escapeHtml(session.name)}" maxlength="80" /></div></section>
          <section class="card stack"><div><h2>Overlay appearance</h2><p class="subtle">Choose how avatars and cameras are arranged in OBS.</p></div><div class="field"><label>Layout</label><select class="input" name="layout"><option value="row" ${session.layout === "row" ? "selected" : ""}>Horizontal row</option><option value="arc" ${session.layout === "arc" ? "selected" : ""}>Soft arc</option><option value="stack" ${session.layout === "stack" ? "selected" : ""}>Vertical stack</option></select></div><div class="field"><label>Preview background</label><select class="input" name="background"><option value="transparent" ${session.background === "transparent" ? "selected" : ""}>Transparent</option><option value="checker" ${session.background === "checker" ? "selected" : ""}>Checker</option><option value="dark" ${session.background === "dark" ? "selected" : ""}>Dark</option></select></div></section>
          <section class="card stack discord-card"><div><h2>Discord connection</h2><p class="subtle">Optional account connection. Invite-link mode keeps working without Discord.</p></div>${discordConnection?.connected ? `<div class="connection-state"><span class="dot live"></span><span>Connected as <strong>${escapeHtml(discordConnection.connected.username)}</strong></span></div><button id="disconnect-discord" class="btn ghost" type="button">Disconnect Discord</button>` : discordConnection?.configured ? `<a class="btn discord-btn" href="/auth/discord">Connect Discord account</a>` : `<p class="hint">Add DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET to the server environment to enable this option.</p>`}</section>
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
  document.querySelector("#add-player").onclick = () => showPlayerModal();
  document.querySelectorAll(".edit").forEach((button) => button.onclick = () => showPlayerModal(players.find((player) => player.id === button.dataset.id)));
  document.querySelectorAll(".mic").forEach((button) => {
    const setSpeaking = async (speaking) => api(`/api/sessions/${session.id}/manual/${encodeURIComponent(button.dataset.id)}`, { method: "POST", body: JSON.stringify({ speaking }) });
    button.onpointerdown = () => setSpeaking(true);
    button.onpointerup = button.onpointerleave = () => setSpeaking(false);
  });
  document.querySelector("#layout").onchange = async (event) => {
    const secrets = { joinToken: session.joinToken, overlayToken: session.overlayToken };
    session = await api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ layout: event.target.value }) });
    Object.assign(session, secrets);
    renderDashboard();
  };
  document.querySelectorAll("[data-view]").forEach((button) => button.onclick = () => {
    activeView = button.dataset.view;
    renderDashboard();
  });
  document.querySelector("#settings-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const secrets = { joinToken: session.joinToken, overlayToken: session.overlayToken };
    session = await api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ name: form.get("name"), layout: form.get("layout"), background: form.get("background") }) });
    Object.assign(session, secrets);
    toast("Settings saved");
    renderDashboard();
  };
  document.querySelector("#sign-out").onclick = async () => {
    await api("/api/auth/logout", { method: "POST" });
    await initializeHost();
  };
  document.querySelector("#disconnect-discord")?.addEventListener("click", async () => {
    await api("/api/discord/disconnect", { method: "POST" });
    discordConnection = await api("/api/discord/status");
    toast("Discord disconnected");
    renderDashboard();
  });
}

function showPlayerModal(player = null) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<form class="modal-card" id="player-form">
    <h2>${player ? "Edit player" : "Add player"}</h2>
    <div class="field"><label>Stable player ID</label><input name="id" class="input mono" required value="${escapeHtml(player?.id || "")}" ${player ? "readonly" : ""} placeholder="player-name" /></div>
    <div class="field"><label>Display name</label><input name="name" class="input" required value="${escapeHtml(player?.name || "")}" placeholder="Player name" /></div>
    <div class="two-col"><div class="field"><label>Idle image</label><input name="idle" class="input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" /></div><div class="field"><label>Talking image</label><input name="talking" class="input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" /></div></div>
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
    await api(`/api/sessions/${session.id}/players/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name: form.get("name"), accent: form.get("accent"), pinned: true, speakingAnimation: form.get("animateSpeaking") ? form.get("speakingAnimation") : "none" }) });
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
      <section class="join-card">
        ${brandMarkup()}
        <div class="eyebrow">Player setup</div>
        <h1>Join the overlay</h1>
        <p class="join-copy">Choose PNG images or a webcam. Microphone audio stays on this device. Webcam mode sends camera frames only to this PNGCalls server.</p>
        <form id="join-form" class="stack">
          <div class="field"><label>Display name</label><input class="input" name="name" required maxlength="60" placeholder="Your name" /></div>
          <div class="field"><label>Appearance</label><select id="media-mode" class="input" name="mediaMode"><option value="png">PNG images</option><option value="webcam">Webcam</option></select></div>
          <div id="png-fields" class="two-col"><div class="field"><label>Idle image</label><input class="input" name="idle" type="file" required accept="image/png,image/jpeg,image/webp,image/gif" /></div><div class="field"><label>Talking image</label><input class="input" name="talking" type="file" required accept="image/png,image/jpeg,image/webp,image/gif" /></div></div>
          <section id="camera-fields" class="camera-picker" hidden>
            <div class="field"><label for="camera-device">Camera source</label><div class="camera-actions"><select id="camera-device" class="input" name="cameraDeviceId" disabled><option value="">Find cameras first</option></select><button id="find-cameras" class="btn ghost" type="button">Find cameras</button></div></div>
            <video id="camera-test-preview" autoplay muted playsinline hidden></video>
            <canvas id="crop-test-preview" class="camera-preview" width="640" height="360" hidden></canvas>
            ${cropControlsMarkup(true)}
            <p id="camera-status" class="hint">Start OBS Virtual Camera, then select it here. A normal webcam also works.</p>
          </section>
          <p id="webcam-note" class="hint" hidden>Your camera is shown as a low-frame-rate tile in OBS. PNGCalls replaces the latest frame and does not make a video recording.</p>
          <div class="field"><label>Speaking accent</label><input class="input" name="accent" type="color" value="#d0193c" /><span class="hint">Used for the name outline, webcam border, and glow while speaking.</span></div>
          <div class="animation-controls"><label class="check-row"><input id="animate-speaking" name="animateSpeaking" type="checkbox" /><span>Animate while speaking</span></label><div class="field"><label for="speaking-animation">Animation style</label><select id="speaking-animation" name="speakingAnimation" class="input" disabled><option value="bounce">Bounce</option><option value="pulse">Pulse</option><option value="shake">Shake</option><option value="glow">Glow</option></select></div></div>
          <button class="btn primary" type="submit">Join and enable microphone</button>
        </form>
      </section>
    </main>`;
    const modeSelect = document.querySelector("#media-mode");
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
      try {
        await openCameraPreview(cameraSelect.value);
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
        const preferred = cameraSelect.value || devices.find((device) => /obs virtual camera/i.test(device.label))?.deviceId || devices[0]?.deviceId || "";
        cameraSelect.innerHTML = devices.length
          ? devices.map((device, index) => `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === preferred ? "selected" : ""}>${escapeHtml(device.label || `Camera ${index + 1}`)}</option>`).join("")
          : `<option value="">No cameras found</option>`;
        cameraSelect.disabled = !devices.length;
        if (preferred && cameraPreviewStream?.getVideoTracks()[0]?.getSettings().deviceId !== preferred) await openCameraPreview(preferred);
        cameraStatus.textContent = devices.length ? `${devices.length} camera source${devices.length === 1 ? "" : "s"} found.` : "No camera sources were found.";
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
        const joined = await api(`/api/join/${id}/${joinToken}`, { method: "POST", body: JSON.stringify({ name: form.get("name"), accent: form.get("accent"), mediaMode, speakingAnimation }) });
        identity = {
          playerId: joined.playerId,
          name: form.get("name"),
          mediaMode,
          cameraDeviceId: mediaMode === "webcam" ? form.get("cameraDeviceId") || "" : "",
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
  app.innerHTML = `<main class="join-page"><section class="join-card active-mic">
    ${brandMarkup()}
    <div class="eyebrow">Connected as ${escapeHtml(identity.name)}</div>
    <h1>Keep this tab open</h1>
    <p class="join-copy">${useWebcam ? "Your camera frames go to this PNGCalls server while this tab stays open." : "You can minimize this window. Only your speaking status is sent to the overlay."}</p>
    ${useWebcam ? `<video id="camera-preview" autoplay muted playsinline hidden></video><canvas id="camera-output-preview" class="camera-preview" width="640" height="360"></canvas>${cropControlsMarkup()}` : ""}
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

  let stream;
  try {
    const camera = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 12, max: 15 } };
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
          video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 12, max: 15 } },
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
    let sendingFrame = false;
    setInterval(() => {
      if (sendingFrame || video.readyState < 2) return;
      sendingFrame = true;
      canvas.toBlob(async (blob) => {
        try {
          if (blob) await api(`/api/join/${id}/${joinToken}/${identity.playerId}/webcam-frame`, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob });
        } catch {}
        sendingFrame = false;
      }, "image/jpeg", 0.72);
    }, 350);
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
    const nextStructure = data.players.map((player) => [player.id, player.mediaMode, player.idleImage || "", player.talkingImage || ""].join(":")).join("|");
    let stage = app.querySelector(".overlay-stage");
    if (!stage || nextStructure !== playerStructure) {
      app.innerHTML = `<main class="overlay-stage ${escapeHtml(data.layout)}">${data.players.map(avatarMarkup).join("")}</main>`;
      playerStructure = nextStructure;
      return;
    }
    stage.className = `overlay-stage ${data.layout}`;
    [...stage.querySelectorAll(".avatar")].forEach((avatar, index) => {
      const player = data.players[index];
      avatar.classList.toggle("speaking", Boolean(player.speaking));
      avatar.classList.remove("animation-none", "animation-bounce", "animation-pulse", "animation-shake", "animation-glow");
      avatar.classList.add(`animation-${["bounce", "pulse", "shake", "glow"].includes(player.speakingAnimation) ? player.speakingAnimation : "none"}`);
      avatar.style.setProperty("--accent", player.accent);
      avatar.querySelector(".avatar-name").textContent = player.name;
      if (player.mediaMode !== "webcam") {
        const image = player.speaking ? player.talkingImage || player.idleImage : player.idleImage;
        const element = avatar.querySelector(".avatar-img");
        if (element && image && element.getAttribute("src") !== image) element.src = image;
      }
    });
  };
  try {
    render(await api(`/api/overlay/${id}/${overlayToken}`));
    const events = new EventSource(`/api/events/${id}/${overlayToken}`);
    events.onmessage = (event) => render(JSON.parse(event.data));
  } catch {
    app.innerHTML = "";
  }
}

if (isOverlay) runOverlay();
else if (isJoin) runJoin();
else initializeHost();
