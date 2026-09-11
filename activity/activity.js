import { DiscordSDK } from "@discord/embedded-app-sdk";

const statusText = document.querySelector("#activity-status");
const detailText = document.querySelector("#activity-detail");
const roomPanel = document.querySelector("#room-panel");
const roomSelect = document.querySelector("#activity-room");
const connectButton = document.querySelector("#activity-connect");
const peopleList = document.querySelector("#activity-people");
const users = new Map();
let discordSdk;
let bridgeToken;
let socket;
let heartbeat;
let selectedRoom;
let channelName = "Discord call";

function setStatus(title, detail = "") {
  statusText.textContent = title;
  detailText.textContent = detail;
}

function displayName(user) {
  return user?.nick || user?.nickname || user?.global_name || user?.username || "Discord user";
}

function remember(user, extra = {}) {
  const id = String(user?.id || user?.user_id || "");
  if (!id) return;
  const current = users.get(id) || { id, name: `Discord user ${id.slice(-4)}`, speaking: false, muted: false, bot: false, avatar: "" };
  users.set(id, {
    ...current,
    name: displayName(user) === "Discord user" ? current.name : displayName(user),
    bot: Boolean(user?.bot ?? current.bot),
    avatar: typeof user?.avatar === "string" && user.avatar ? user.avatar : current.avatar,
    ...extra,
  });
}

function renderPeople() {
  peopleList.replaceChildren();
  for (const user of users.values()) {
    if (user.bot) continue;
    const row = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = `voice-dot${user.speaking ? " speaking" : ""}`;
    const name = document.createElement("span");
    name.textContent = user.name;
    row.append(dot, name);
    peopleList.append(row);
  }
}

function sendSnapshot() {
  renderPeople();
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "snapshot",
    channel: { id: discordSdk.channelId, name: channelName },
    users: [...users.values()],
  }));
}

async function subscribeToCall() {
  const args = { channel_id: discordSdk.channelId };
  await discordSdk.subscribe("SPEAKING_START", ({ user_id }) => {
    remember({ id: user_id }, { speaking: true });
    sendSnapshot();
  }, args);
  await discordSdk.subscribe("SPEAKING_STOP", ({ user_id }) => {
    remember({ id: user_id }, { speaking: false });
    sendSnapshot();
  }, args);
  await discordSdk.subscribe("VOICE_STATE_UPDATE", (state) => {
    remember(state.user, { name: displayName(state), muted: Boolean(state.mute || state.voice_state?.mute || state.voice_state?.self_mute) });
    sendSnapshot();
  }, args);
  await discordSdk.subscribe("ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE", ({ participants }) => {
    for (const participant of participants || []) remember(participant);
    sendSnapshot();
  });
}

async function seedPeople(auth) {
  remember(auth.user);
  try {
    const { participants } = await discordSdk.commands.getInstanceConnectedParticipants();
    for (const participant of participants || []) remember(participant);
  } catch {}
  try {
    const channel = await discordSdk.commands.getChannel({ channel_id: discordSdk.channelId });
    channelName = channel?.name || (channel?.type === 1 ? "Direct message" : "Discord call");
    for (const state of channel?.voice_states || []) {
      remember(state.user, { name: displayName(state), muted: Boolean(state.mute || state.voice_state?.mute || state.voice_state?.self_mute) });
    }
  } catch {}
  renderPeople();
}

function connectRoom() {
  selectedRoom = roomSelect.value;
  if (!selectedRoom) return;
  localStorage.setItem("pngcalls-activity-room", selectedRoom);
  socket?.close();
  clearInterval(heartbeat);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws/activity/${encodeURIComponent(selectedRoom)}/${encodeURIComponent(bridgeToken)}`);
  setStatus("Connecting to PNGCalls", "The Activity will stay quiet in the background.");
  socket.addEventListener("open", () => {
    setStatus("Call detection is live", "Checking the current call participants...");
    sendSnapshot();
    heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" }));
    }, 5000);
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.type !== "snapshot_ack") return;
      const count = Number(message.count || 0);
      setStatus("Call detection is live", `${count} participant${count === 1 ? "" : "s"} sent to ${message.roomName || "PNGCalls"}. Keep this Activity open.`);
    } catch {}
  });
  socket.addEventListener("close", () => {
    clearInterval(heartbeat);
    setStatus("PNGCalls disconnected", "Press Connect to try again.");
  });
  socket.addEventListener("error", () => setStatus("Could not reach PNGCalls", "Check that the server and Cloudflare Tunnel are online."));
}

async function start() {
  const configResponse = await fetch("/api/discord/activity/config", { cache: "no-store" });
  const config = await configResponse.json();
  if (!config.enabled || !config.clientId) throw new Error("Configure Discord in the PNGCalls dashboard first.");
  discordSdk = new DiscordSDK(config.clientId);
  await discordSdk.ready();
  if (!discordSdk.channelId) throw new Error("Start PNGCalls from the App Launcher inside an active Discord call.");
  const { code } = await discordSdk.commands.authorize({
    client_id: config.clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify", "guilds", "rpc.voice.read"],
  });
  const tokenResponse = await fetch("/api/discord/activity/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const result = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error(result.error || "PNGCalls rejected the Activity connection.");
  bridgeToken = result.bridge_token;
  const auth = await discordSdk.commands.authenticate({ access_token: result.access_token });
  if (!auth?.user) throw new Error("Discord Activity authentication failed.");
  await seedPeople(auth);
  await subscribeToCall();
  roomSelect.replaceChildren(...result.rooms.map((room) => {
    const option = document.createElement("option");
    option.value = room.id;
    option.textContent = room.name;
    return option;
  }));
  if (!result.rooms.length) throw new Error("Create a PNGCalls room in the dashboard first.");
  const savedRoom = localStorage.getItem("pngcalls-activity-room");
  if (result.rooms.some((room) => room.id === savedRoom)) roomSelect.value = savedRoom;
  roomPanel.hidden = false;
  connectButton.addEventListener("click", connectRoom);
  connectRoom();
}

start().catch((error) => {
  console.error(error);
  setStatus("Activity setup is incomplete", error?.message || "Open PNGCalls Settings and check the Discord configuration.");
});
