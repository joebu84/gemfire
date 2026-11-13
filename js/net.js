// Friend-code multiplayer over PeerJS. The host's browser is the console.
// Guests receive the host's picture and sound, and send their own buttons back.

export const PEER_PREFIX = "gemfire-v1-";
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ICE = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    {
      urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp"],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

export function newCode() {
  let code = "";
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 6; i++) code += CODE_ABC[buf[i] % CODE_ABC.length];
  return code;
}

export function parseCode(raw) {
  const text = String(raw || "").trim();
  const fromUrl = text.match(/(?:^|[?&\s])room=([A-Za-z0-9]+)/i);
  const body = fromUrl ? fromUrl[1] : text;
  return body.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

export function shareUrl(code) {
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/index\.html$/, "");
  url.searchParams.set("room", code);
  return url.toString();
}

function peerErrorText(err) {
  const type = err && err.type;
  if (type === "peer-unavailable") return "That room is not open. Check the code, and make sure the host's tab is still open.";
  if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed" || type === "disconnected") {
    return "Could not reach matchmaking. Try again in a moment.";
  }
  if (type === "browser-incompatible") return "This browser cannot do peer-to-peer play.";
  return "Could not connect.";
}

export class HostSession {
  constructor({ onInput, onMedia, onState }) {
    this.onInput = onInput;
    this.onMedia = onMedia;
    this.onState = onState || (() => {});
    this.code = "";
    this.peer = null;
    this.stream = null;
    this.guests = []; // { conn, slot, name, call }
    this.closed = false;
  }

  start() {
    this.code = newCode();
    this._open(0);
    return this.code;
  }

  setStream(stream) {
    this.stream = stream;
    for (const guest of this.guests) this._call(guest);
    this._emit();
  }

  destroy() {
    this.closed = true;
    for (const guest of this.guests) {
      try { guest.call && guest.call.close(); } catch { /* already gone */ }
      try { guest.conn.close(); } catch { /* already gone */ }
    }
    this.guests = [];
    try { this.peer && this.peer.destroy(); } catch { /* already gone */ }
  }

  _emit() {
    const slots = [null, null, null, null];
    slots[0] = { slot: 1, name: "You", remote: false };
    for (const guest of this.guests) slots[guest.slot] = { slot: guest.slot + 1, name: guest.name, remote: true };
    this.onState({
      status: this.peer && this.peer.open ? "online" : "connecting",
      code: this.code,
      url: shareUrl(this.code),
      slots,
      live: !!(this.stream && this.stream.getVideoTracks().length),
    });
  }

  _open(tries) {
    if (this.closed) return;
    this._emit();
    const peer = new window.Peer(PEER_PREFIX + this.code, { config: ICE, debug: 0 });
    this.peer = peer;
    const timer = setTimeout(() => {
      if (!peer.open && !this.closed) this.onState({ status: "error", message: "Could not reach matchmaking. Try again in a moment.", code: this.code });
    }, 15000);
    peer.on("open", () => {
      clearTimeout(timer);
      this._emit();
    });
    peer.on("connection", (conn) => this._addGuest(conn));
    peer.on("disconnected", () => {
      this.onState({ status: "reconnecting", code: this.code, message: "Reconnecting…" });
      setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 1500);
    });
    peer.on("error", (err) => {
      if (err.type === "unavailable-id" && tries < 5 && !peer.open) {
        clearTimeout(timer);
        try { peer.destroy(); } catch { /* ignore */ }
        this.code = newCode();
        this._open(tries + 1);
        return;
      }
      if (err.type === "peer-unavailable") return;
      console.warn(err);
      if (!peer.open) this.onState({ status: "error", message: peerErrorText(err), code: this.code });
    });
  }

  _addGuest(conn) {
    const guest = { conn, slot: -1, name: "Friend", call: null, pending: [] };
    conn.on("data", (msg) => {
      if (guest.slot < 0) guest.pending.push(msg);
      else this._onData(guest, msg);
    });
    conn.on("close", () => { if (guest.slot >= 0) this._drop(guest); });
    conn.on("error", () => { if (guest.slot >= 0) this._drop(guest); });
    conn.on("open", () => {
      const free = [1, 2, 3].find((slot) => !this.guests.some((g) => g.slot === slot));
      if (free === undefined) {
        try { conn.send({ t: "full" }); } catch { /* ignore */ }
        setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 50);
        return;
      }
      guest.slot = free;
      this.guests.push(guest);
      for (const msg of guest.pending) this._onData(guest, msg);
      guest.pending = [];
    });
  }

  _onData(guest, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      guest.name = String(msg.name || "Friend").replace(/[\u0000-\u001f]/g, "").slice(0, 16) || "Friend";
      try { guest.conn.send({ t: "welcome", player: guest.slot + 1 }); } catch { /* ignore */ }
      this._call(guest);
      this._emit();
      return;
    }
    if (msg.t === "pad") this.onInput(guest.slot, msg.m | 0);
  }

  _call(guest) {
    if (!this.stream || guest.call || !this.peer) return;
    try {
      const call = this.peer.call(guest.conn.peer, this.stream);
      guest.call = call;
      if (this.onMedia) this.onMedia(call);
      call.on("close", () => {
        if (guest.call === call) guest.call = null;
      });
    } catch (e) {
      console.warn(e);
    }
  }

  _drop(guest) {
    const idx = this.guests.indexOf(guest);
    if (idx < 0) return;
    this.guests.splice(idx, 1);
    this.onInput(guest.slot, 0);
    try { guest.call && guest.call.close(); } catch { /* ignore */ }
    this._emit();
  }
}

export class GuestSession {
  constructor({ code, name, onState, onStream }) {
    this.code = code;
    this.name = name;
    this.onState = onState || (() => {});
    this.onStream = onStream || (() => {});
    this.peer = null;
    this.conn = null;
    this.player = 0;
    this.closed = false;
  }

  start() {
    this.onState({ status: "connecting", message: "Connecting…" });
    const peer = new window.Peer({ config: ICE, debug: 0 });
    this.peer = peer;
    peer.on("call", (call) => {
      call.answer(new MediaStream());
      call.on("stream", (stream) => this.onStream(stream));
      call.on("error", () => this.onState({ status: "online", player: this.player, message: "Picture disconnected. Stay on this page; it may return." }));
    });
    const fail = (err) => {
      if (this.closed) return;
      this.onState({ status: "error", message: peerErrorText(err) });
    };
    const timer = setTimeout(() => fail({ type: "network" }), 15000);
    peer.on("open", () => {
      const conn = peer.connect(PEER_PREFIX + this.code, { reliable: true, serialization: "json" });
      this.conn = conn;
      const openTimer = setTimeout(() => {
        if (!conn.open) fail({ type: "peer-unavailable" });
      }, 15000);
      conn.on("open", () => {
        clearTimeout(timer);
        clearTimeout(openTimer);
        this._hello();
        this._helloTimer = setInterval(() => { if (!this.player) this._hello(); }, 1000);
      });
      conn.on("data", (msg) => this._onData(msg));
      conn.on("close", () => {
        if (!this.closed) this.onState({ status: "error", message: "The host disconnected." });
      });
    });
    peer.on("error", (err) => {
      clearTimeout(timer);
      if (err.type === "peer-unavailable" || !peer.open) fail(err);
    });
  }

  sendPad(mask) {
    if (!this.conn || !this.conn.open || !this.player) return;
    try { this.conn.send({ t: "pad", m: mask }); } catch { /* channel closing */ }
  }

  destroy() {
    this.closed = true;
    clearInterval(this._helloTimer);
    try { this.conn && this.conn.close(); } catch { /* ignore */ }
    try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
  }

  _hello() {
    try { this.conn.send({ t: "hello", name: this.name }); } catch { /* ignore */ }
  }

  _onData(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "full") {
      this.onState({ status: "error", message: "That game is full. Gemfire on this page takes the host plus 3 friends." });
      this.destroy();
      return;
    }
    if (msg.t === "welcome") {
      this.player = msg.player;
      clearInterval(this._helloTimer);
      this.onState({ status: "online", player: this.player, message: "Joined as player " + this.player + ". Waiting for the picture…" });
    }
  }
}
