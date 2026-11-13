// Decrypt rom/gemfire.bin.enc with the parameters in rom/gemfire.enc.json.
// Salt, iv, iterations and sizes are always read from that file.

export class RomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new RomError("format", "The ROM parameters are not valid.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) throw new RomError("format", "The ROM parameters are not valid.");
    out[i] = byte;
  }
  return out;
}

export async function decryptRomBytes(password, params, ciphertext) {
  if (!params || params.cipher !== "AES-GCM" || params.kdf !== "PBKDF2") {
    throw new RomError("format", "This ROM uses an unexpected encryption format.");
  }
  const salt = hexToBytes(params.salt);
  const iv = hexToBytes(params.iv);
  const hash = params.hash || "SHA-256";
  const iterations = params.iterations;
  const keyLength = params.keyLength || 256;
  if (!iterations || iv.length !== 12) {
    throw new RomError("format", "The ROM parameters are not valid.");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash },
    material,
    { name: "AES-GCM", length: keyLength },
    false,
    ["decrypt"]
  );
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  } catch {
    throw new RomError("password", "Wrong password.");
  }
  if (params.plaintextSize && plain.byteLength !== params.plaintextSize) {
    throw new RomError("format", "The ROM decrypted to an unexpected size.");
  }
  return new Uint8Array(plain);
}

async function load(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new RomError("download", "Could not download the ROM.");
  return res;
}

export async function decryptRom(password) {
  const base = document.baseURI;
  let paramsRes;
  let cipherRes;
  try {
    [paramsRes, cipherRes] = await Promise.all([
      load(new URL("rom/gemfire.enc.json", base)),
      load(new URL("rom/gemfire.bin.enc", base)),
    ]);
  } catch (e) {
    if (e instanceof RomError) throw e;
    throw new RomError("download", "Could not download the ROM.");
  }
  const params = await paramsRes.json();
  const ciphertext = new Uint8Array(await cipherRes.arrayBuffer());
  return decryptRomBytes(password, params, ciphertext);
}
