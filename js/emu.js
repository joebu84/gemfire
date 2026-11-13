// Host-side emulator. Guests never run a core: they watch this canvas.
import { audioTrack } from "./audio-tap.js";

// Genesis Plus GX libretro subclasses (RETRO_DEVICE_SUBCLASS of JOYPAD).
// 4-Way Play maps retro pads 0..3 onto Genesis ports 1..4.
export const ADAPTERS = {
  way: { id: 1025, label: "EA 4-Way Play" },
  team: { id: 1537, label: "Sega Team Player" },
};

// RetroPad indexes. On a 3-button pad, Y is Genesis A and A is Genesis C.
const BITS = [4, 5, 6, 7, 1, 0, 8, 3]; // up down left right A B C Start

const DATA = "https://cdn.emulatorjs.org/latest/data/";

let mediaStream = null;
let capturedCanvas = null;
let mirror = null;
let mirrorCtx = null;
let mirrorSrc = null;
let mirrorGen = 0;

// WebGL canvases present a frame and then clear it. captureStream() of that
// canvas encodes as black over WebRTC. Keeping the buffer and copying into a
// 2D canvas gives the peer connection a normal video track.
export function installCaptureFix() {
  if (installCaptureFix.done) return;
  installCaptureFix.done = true;
  const patch = (proto) => {
    if (!proto || proto.__gemfirePatched) return;
    const orig = proto.getContext;
    proto.getContext = function (type, options) {
      if (typeof type === "string" && /webgl/i.test(type)) {
        options = Object.assign({}, options, { preserveDrawingBuffer: true });
      }
      return orig.call(this, type, options);
    };
    proto.__gemfirePatched = true;
  };
  patch(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas !== "undefined") patch(OffscreenCanvas.prototype);
}

function mirrorOf(src) {
  if (!mirror) {
    mirror = document.createElement("canvas");
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;pointer-events:none";
    document.body.appendChild(mirror);
    mirrorCtx = mirror.getContext("2d", { alpha: false });
  }
  if (mirrorSrc !== src) {
    mirrorSrc = src;
    const gen = ++mirrorGen;
    const loop = () => {
      if (gen !== mirrorGen) return;
      requestAnimationFrame(loop);
      const w = src.width;
      const h = src.height;
      if (!w || !h) return;
      if (mirror.width !== w || mirror.height !== h) {
        mirror.width = w;
        mirror.height = h;
      }
      try { mirrorCtx.drawImage(src, 0, 0); } catch { /* context not ready yet */ }
    };
    loop();
  }
  return mirror;
}
let bootedFlag = false;
const calls = new Set();
const desired = [0, 0, 0, 0];
const applied = [0, 0, 0, 0];
let padTimer = 0;

export function adapterMode() {
  return localStorage.getItem("gemfire.adapter") === "team" ? "team" : "way";
}

export function isBooted() {
  return bootedFlag;
}

export function currentStream() {
  return mediaStream;
}

export function masks() {
  return desired.slice();
}

function canvasEl() {
  const emu = window.EJS_emulator;
  if (emu && emu.frontend && emu.frontend.canvas) return emu.frontend.canvas;
  return document.querySelector("#emu canvas");
}

function gameManager() {
  const emu = window.EJS_emulator;
  return emu && emu.gameManager;
}

export function applyPad(player, mask) {
  if (player < 1 || player > 3) return;
  desired[player] = mask & 0xff;
  flushPad(player, false);
}

function flushPad(player, force) {
  const gm = gameManager();
  if (!gm || typeof gm.simulateInput !== "function") return;
  const want = desired[player];
  if (!force && applied[player] === want) return;
  for (let bit = 0; bit < BITS.length; bit++) {
    const now = (want >> bit) & 1;
    const was = (applied[player] >> bit) & 1;
    if (force || now !== was) {
      try { gm.simulateInput(player, BITS[bit], now); } catch (e) { console.warn(e); }
    }
  }
  applied[player] = want;
}

export function startPadSync() {
  if (padTimer) return;
  padTimer = setInterval(() => {
    for (let i = 1; i <= 3; i++) flushPad(i, true);
  }, 1000);
}

export function watchCall(call) {
  calls.add(call);
  const drop = () => calls.delete(call);
  call.on("close", drop);
  call.on("error", drop);
  setTimeout(() => tuneCall(call), 800);
}

async function tuneCall(call) {
  const pc = call.peerConnection;
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== "video") continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 4000000;
      params.degradationPreference = "maintain-resolution";
      await sender.setParameters(params);
    } catch {
      /* older browsers ignore this */
    }
  }
}

async function pushTracks() {
  if (!mediaStream) return;
  for (const call of calls) {
    const pc = call.peerConnection;
    if (!pc) continue;
    for (const track of mediaStream.getTracks()) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === track.kind);
      if (sender && sender.track !== track) {
        try { await sender.replaceTrack(track); } catch (e) { console.warn(e); }
      }
    }
  }
}

export function ensureStream() {
  const canvas = canvasEl();
  if (!canvas || !canvas.captureStream) return mediaStream;
  if (!mediaStream) mediaStream = new MediaStream();
  const source = mirrorOf(canvas);
  if (canvas !== capturedCanvas) {
    let raw;
    try { raw = source.captureStream(30); } catch { raw = null; }
    const video = raw && raw.getVideoTracks()[0];
    if (video) {
      try { video.contentHint = "detail"; } catch { /* optional */ }
      const prev = mediaStream.getVideoTracks()[0];
      if (prev) mediaStream.removeTrack(prev);
      mediaStream.addTrack(video);
      capturedCanvas = canvas;
      pushTracks();
    }
  }
  if (!mediaStream.getAudioTracks().length) {
    const track = audioTrack();
    if (track) {
      mediaStream.addTrack(track);
      pushTracks();
    }
  }
  return mediaStream.getVideoTracks().length ? mediaStream : null;
}

export function whenStreamReady() {
  let videoSeen = 0;
  return new Promise((resolve) => {
    const tick = () => {
      const stream = ensureStream();
      const video = stream && stream.getVideoTracks().length;
      const audio = stream && stream.getAudioTracks().length;
      if (video) videoSeen += 1;
      if (video && (audio || videoSeen > 12)) resolve(stream);
      else setTimeout(tick, 250);
    };
    tick();
  });
}

export function setMultitap(mode, { restart = false } = {}) {
  const id = (ADAPTERS[mode] || ADAPTERS.way).id;
  localStorage.setItem("gemfire.adapter", mode === "team" ? "team" : "way");
  const gm = gameManager();
  if (!gm) return;
  try {
    const path = "/home/web_user/.config/retroarch/retroarch.cfg";
    let cfg = new TextDecoder().decode(gm.FS.readFile(path));
    const line = `input_libretro_device_p1 = ${id}`;
    if (/^input_libretro_device_p1\s*=.*$/m.test(cfg)) cfg = cfg.replace(/^input_libretro_device_p1\s*=.*$/m, line);
    else cfg += `\n${line}\n`;
    gm.FS.writeFile(path, cfg);
  } catch (e) {
    console.warn(e);
  }
  try { gm.setControllerPortDevice(0, id); } catch (e) { console.warn(e); }
  if (restart) {
    try { gm.restart(); } catch (e) { console.warn(e); }
    setTimeout(() => {
      try { gm.setControllerPortDevice(0, id); } catch { /* core may still be restarting */ }
      capturedCanvas = null;
      ensureStream();
    }, 600);
  }
}

function retroarchOpts() {
  const id = ADAPTERS[adapterMode()].id;
  return {
    input_libretro_device_p1: id,
    input_libretro_device_p2: 1,
    input_libretro_device_p3: 1,
    input_libretro_device_p4: 1,
  };
}

export function startEmulator(romBytes, { onStart, onFail } = {}) {
  const blob = new Blob([romBytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  window.EJS_player = "#emu";
  window.EJS_gameUrl = url;
  window.EJS_core = "segaMD";
  window.EJS_controlScheme = "segaMD";
  window.EJS_gameName = "Gemfire";
  window.EJS_gameID = 199203;
  window.EJS_pathtodata = DATA;
  window.EJS_startOnLoaded = true;
  window.EJS_disableAutoLang = false;
  window.EJS_color = "#e2b340";
  window.EJS_backgroundColor = "#140e09";
  window.EJS_volume = 1;
  window.EJS_alignStartButton = "center";
  window.EJS_retroarchOpts = retroarchOpts();
  // Match the guest keyboard: Z A, X B, C C, Enter Start, arrows move.
  window.EJS_defaultControls = {
    0: {
      0: { value: "x", value2: "BUTTON_2" },
      1: { value: "z", value2: "BUTTON_4" },
      8: { value: "c", value2: "BUTTON_1" },
      3: { value: "enter", value2: "START" },
      4: { value: "up arrow", value2: "DPAD_UP" },
      5: { value: "down arrow", value2: "DPAD_DOWN" },
      6: { value: "left arrow", value2: "DPAD_LEFT" },
      7: { value: "right arrow", value2: "DPAD_RIGHT" },
    },
  };
  window.EJS_Buttons = {
    cheat: false,
    cacheManager: false,
    screenshot: false,
    saveState: true,
    loadState: true,
    fullscreen: true,
  };
  window.EJS_onGameStart = () => {
    bootedFlag = true;
    for (let i = 1; i <= 3; i++) applied[i] = -1;
    for (let i = 1; i <= 3; i++) flushPad(i, true);
    ensureStream();
    if (onStart) onStart();
  };
  const bootMode = adapterMode();
  let restartedForAdapter = false;
  const previousStart = window.EJS_onGameStart;
  window.EJS_onGameStart = () => {
    if (!restartedForAdapter && adapterMode() !== bootMode) {
      restartedForAdapter = true;
      setMultitap(adapterMode(), { restart: true });
    }
    previousStart();
  };
  const script = document.createElement("script");
  script.src = DATA + "loader.js";
  script.async = true;
  script.onerror = () => onFail && onFail("Could not load the emulator. Check your connection and try again.");
  document.body.appendChild(script);
  const watch = new MutationObserver(() => ensureStream());
  const root = document.querySelector("#emu");
  if (root) watch.observe(root, { childList: true, subtree: true });
}
