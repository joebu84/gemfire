import { installAudioTap } from "./audio-tap.js";
import { decryptRom, RomError } from "./rom.js";
import { installCaptureFix, startEmulator, whenStreamReady, applyPad, setMultitap, adapterMode, ADAPTERS, startPadSync, watchCall, isBooted, masks } from "./emu.js";
import { HostSession, GuestSession, shareUrl, parseCode } from "./net.js";

installAudioTap();
installCaptureFix();

const $ = (id) => document.getElementById(id);
const gate = $("gate");
const app = $("app");
const lobby = $("lobby");
const play = $("play");
const gateForm = $("gateForm");
const password = $("password");
const remember = $("remember");
const gateMsg = $("gateMsg");
const lobbyMsg = $("lobbyMsg");
const codeInput = $("codeInput");
const nameInput = $("nameInput");
const roomBox = $("roomBox");
const roomCode = $("roomCode");
const who = $("who");
const statusLine = $("statusLine");
const remote = $("remote");
const tapSound = $("tapSound");
const pad = $("pad");
const adapter = $("adapter");
const help = $("help");

let romBytes = null;
let hostSession = null;
let guestSession = null;
let role = "";
let touchMask = 0;
let guestMask = 0;
let lastSent = -1;
const held = new Set();

const state = {
  get role() { return role; },
  get code() { return hostSession ? hostSession.code : ""; },
  get booted() { return isBooted(); },
  get masks() { return masks(); },
  get player() { return guestSession ? guestSession.player : role === "host" || role === "solo" ? 1 : 0; },
};
window.__gemfire = state;

const presetRoom = parseCode(new URLSearchParams(location.search).get("room") || "");
if (presetRoom.length === 6) codeInput.value = presetRoom;
adapter.value = adapterMode();

function paint(el, text) {
  el.textContent = text || "";
}

async function unlock(pw, fromSession) {
  paint(gateMsg, "Unlocking…");
  $("unlockBtn").disabled = true;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    romBytes = await decryptRom(pw);
  } catch (e) {
    romBytes = null;
    $("unlockBtn").disabled = false;
    if (fromSession) sessionStorage.removeItem("gemfire.session");
    paint(gateMsg, e instanceof RomError ? e.message : "Could not open the ROM.");
    return;
  }
  if (remember.checked) sessionStorage.setItem("gemfire.session", pw);
  else sessionStorage.removeItem("gemfire.session");
  gate.classList.add("hidden");
  app.classList.remove("hidden");
  paint(gateMsg, "");
  if (presetRoom.length === 6) {
    paint(lobbyMsg, "This link is for room " + presetRoom + ". Unlock is done — press Join when you are ready.");
    $("joinBtn").focus();
  }
}

gateForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const pw = password.value;
  if (!pw) {
    paint(gateMsg, "Enter the password.");
    return;
  }
  unlock(pw, false);
});

const saved = sessionStorage.getItem("gemfire.session");
if (saved) {
  password.value = saved;
  remember.checked = true;
  unlock(saved, true);
} else {
  password.focus();
}

function showPlay() {
  lobby.classList.add("hidden");
  play.classList.remove("hidden");
  document.body.classList.add("playing");
}

function enterSoloOrHost(hosting) {
  if (role) return;
  if (!romBytes) {
    paint(lobbyMsg, "Unlock the ROM first.");
    return;
  }
  role = hosting ? "host" : "solo";
  showPlay();
  adapter.hidden = false;
  $("adapterLabel").hidden = false;
  paint(statusLine, "Starting Gemfire…");
  const bytes = romBytes;
  romBytes = null;
  if (hosting) openRoom();
  startEmulator(bytes, {
    onStart: () => {
      paint(statusLine, hosting ? statusLine.textContent : "Playing solo. Host a game whenever you want friends to join.");
      if (hosting) publishStream();
    },
    onFail: (msg) => paint(statusLine, msg),
  });
  try { navigator.wakeLock && navigator.wakeLock.request("screen"); } catch { /* optional */ }
}

async function publishStream() {
  const stream = await whenStreamReady();
  if (hostSession) hostSession.setStream(stream);
  if (role === "host") paint(statusLine, "Picture is live. Friends who join can see and hear this tab.");
}

function openRoom() {
  startPadSync();
  hostSession = new HostSession({
    onInput: applyPad,
    onMedia: watchCall,
    onState: (info) => {
      if (info.status === "error") {
        paint(statusLine, info.message || "Could not host.");
        return;
      }
      roomBox.classList.remove("hidden");
      roomCode.textContent = info.code || "";
      const names = (info.slots || []).map((slot, i) => (slot ? "P" + (i + 1) + " " + slot.name : "P" + (i + 1) + " open"));
      who.textContent = names.join("  ·  ");
      who.classList.remove("hidden");
      if (info.message) paint(statusLine, info.message);
      else if (info.status === "online") {
        const n = (info.slots || []).filter(Boolean).length;
        paint(statusLine, n > 1 ? "Hosting " + info.code + " · " + n + " players." : "Hosting " + info.code + ". Waiting for friends.");
      } else paint(statusLine, "Opening the room…");
    },
  });
  hostSession.start();
  role = "host";
  $("hostLateBtn").classList.add("hidden");
}

$("soloBtn").addEventListener("click", () => enterSoloOrHost(false));
$("hostBtn").addEventListener("click", () => enterSoloOrHost(true));
$("hostLateBtn").addEventListener("click", () => {
  if (role !== "solo" || hostSession) return;
  openRoom();
  publishStream();
});

$("joinBtn").addEventListener("click", () => {
  if (role) return;
  const code = parseCode(codeInput.value);
  if (code.length !== 6) {
    paint(lobbyMsg, "Enter the 6-character code.");
    return;
  }
  role = "guest";
  romBytes = null;
  showPlay();
  adapter.hidden = true;
  $("adapterLabel").hidden = true;
  $("hostLateBtn").classList.add("hidden");
  pad.classList.remove("hidden");
  remote.classList.remove("hidden");
  $("emu").classList.add("hidden");
  const name = (nameInput.value || "Friend").trim().slice(0, 16);
  guestSession = new GuestSession({
    code,
    name,
    onState: (info) => {
      paint(statusLine, info.message || "");
      if (info.player) {
        who.textContent = "You are player " + info.player;
        who.classList.remove("hidden");
        lastSent = -1;
        sendPad();
      }
    },
    onStream: attachStream,
  });
  guestSession.start();
});

async function attachStream(stream) {
  remote.srcObject = stream;
  remote.muted = false;
  try {
    await remote.play();
    tapSound.classList.add("hidden");
  } catch {
    remote.muted = true;
    try { await remote.play(); } catch { /* needs a tap */ }
    tapSound.classList.remove("hidden");
  }
  if (guestSession && guestSession.player) {
    paint(statusLine, "Player " + guestSession.player + ". You are watching the host's screen.");
  }
}

tapSound.addEventListener("click", async () => {
  remote.muted = false;
  try { await remote.play(); } catch { /* still blocked */ }
  tapSound.classList.add("hidden");
});

function currentMask() {
  return touchMask | gamepadMask();
}

function sendPad(force) {
  if (!guestSession || !guestSession.player) return;
  guestMask = currentMask();
  if (!force && guestMask === lastSent) return;
  lastSent = guestMask;
  guestSession.sendPad(guestMask);
}

function setBit(bit, down) {
  if (down) touchMask |= 1 << bit;
  else touchMask &= ~(1 << bit);
  sendPad(false);
  document.querySelectorAll('#pad [data-bit="' + bit + '"]').forEach((btn) => btn.classList.toggle("on", down));
}

const keyBits = {
  ArrowUp: 0, KeyW: 0,
  ArrowDown: 1, KeyS: 1,
  ArrowLeft: 2, KeyA: 2,
  ArrowRight: 3, KeyD: 3,
  KeyZ: 4, KeyJ: 4,
  KeyX: 5, KeyK: 5,
  KeyC: 6, KeyL: 6,
  Enter: 7, NumpadEnter: 7, Space: 7,
};

function typing(el) {
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

window.addEventListener("keydown", (e) => {
  if (role !== "guest" || typing(e.target) || help.open) return;
  const bit = keyBits[e.code];
  if (bit === undefined || e.repeat) return;
  e.preventDefault();
  held.add(e.code);
  setBit(bit, true);
});

window.addEventListener("keyup", (e) => {
  if (role !== "guest") return;
  const bit = keyBits[e.code];
  if (bit === undefined) return;
  held.delete(e.code);
  const still = [...held].some((code) => keyBits[code] === bit);
  if (!still) setBit(bit, false);
});

window.addEventListener("blur", () => {
  if (role !== "guest") return;
  held.clear();
  touchMask = 0;
  sendPad(true);
  document.querySelectorAll("#pad button.on").forEach((btn) => btn.classList.remove("on"));
});

pad.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest("[data-bit]");
  if (!btn) return;
  e.preventDefault();
  btn.setPointerCapture(e.pointerId);
  setBit(Number(btn.dataset.bit), true);
});
pad.addEventListener("pointerup", releasePointer);
pad.addEventListener("pointercancel", releasePointer);
function releasePointer(e) {
  const btn = e.target.closest("[data-bit]");
  if (!btn) return;
  setBit(Number(btn.dataset.bit), false);
}
pad.addEventListener("contextmenu", (e) => e.preventDefault());

function gamepadMask() {
  const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
  let mask = 0;
  for (const gp of pads) {
    if (!gp) continue;
    const b = (i) => gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5);
    const ax = gp.axes || [];
    if (b(12) || ax[1] < -0.5) mask |= 1 << 0;
    if (b(13) || ax[1] > 0.5) mask |= 1 << 1;
    if (b(14) || ax[0] < -0.5) mask |= 1 << 2;
    if (b(15) || ax[0] > 0.5) mask |= 1 << 3;
    if (b(2) || b(3)) mask |= 1 << 4;
    if (b(0)) mask |= 1 << 5;
    if (b(1) || b(5)) mask |= 1 << 6;
    if (b(9)) mask |= 1 << 7;
  }
  return mask;
}

setInterval(() => {
  if (role !== "guest") return;
  sendPad(false);
}, 50);
setInterval(() => {
  if (role !== "guest") return;
  sendPad(true);
}, 400);

$("copyBtn").addEventListener("click", async () => {
  if (!hostSession) return;
  const url = shareUrl(hostSession.code);
  const text = "Gemfire room " + hostSession.code + " — " + url;
  try {
    if (navigator.share) {
      await navigator.share({ title: "Gemfire", text: "Join my Gemfire game. Code " + hostSession.code, url });
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }
  try {
    await navigator.clipboard.writeText(text);
    paint(statusLine, "Copied " + hostSession.code + " and the join link.");
  } catch {
    paint(statusLine, "Code " + hostSession.code + " — " + url);
  }
});

$("fsBtn").addEventListener("click", () => {
  const el = document.fullscreenElement ? null : $("play");
  if (!el) document.exitFullscreen();
  else play.requestFullscreen().catch(() => {});
});

$("helpBtn").addEventListener("click", () => help.showModal());
$("helpClose").addEventListener("click", () => help.close());

adapter.addEventListener("change", () => {
  const next = adapter.value === "team" ? "team" : "way";
  if (next === adapterMode()) return;
  const label = ADAPTERS[next].label;
  if (!window.confirm("Switch to " + label + " and restart the game? Gemfire looks for the adapter at power-on.")) {
    adapter.value = adapterMode();
    return;
  }
  setMultitap(next, { restart: true });
  paint(statusLine, "Restarting with " + label + ".");
});

$("backBtn").addEventListener("click", () => {
  location.href = location.pathname;
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    try { navigator.wakeLock && navigator.wakeLock.request("screen"); } catch { /* optional */ }
    return;
  }
  if (role === "host" || role === "solo") {
    paint(statusLine, "This tab is hidden, so the game may pause for everyone.");
  }
});
