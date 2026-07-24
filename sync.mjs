// konomium-vault · sync.mjs — peer-to-peer vault sync (d=2, the pairing)
// Two vaults handshake via WebRTC DataChannel. The handshake key is exchanged
// out-of-band (QR code, local network, paste). No server, no cloud, no TURN.
// The sync is encrypted end-to-end — both sides derive a shared session key
// from the handshake secret, so the DataChannel payload is double-encrypted
// (WebRTC DTLS + our AES-GCM layer).
//
// Sync protocol:
//   1. Initiator generates a random handshake secret, shows it as QR/text.
//   2. Responder scans/pastes the secret.
//   3. Both derive a session key from the secret via PBKDF2.
//   4. They exchange encrypted manifests (list of record IDs + hashes).
//   5. Each side requests records the other has that it doesn't.
//   6. Records arrive still vault-encrypted — sync never sees plaintext.
//
// This module provides the crypto + protocol layer. The WebRTC transport
// and QR display are in sync-transport.mjs (browser) or injected for testing.

const subtle = globalThis.crypto?.subtle;
const ENC = new TextEncoder();
const DEC = new TextDecoder();

function randomHex(n) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveSessionKey(secret, salt) {
  const base = await subtle.importKey('raw', ENC.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: ENC.encode(salt), iterations: 100_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sessionEncrypt(key, data) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, ENC.encode(JSON.stringify(data))));
  return { iv: b64(iv), ct: b64(ct) };
}

async function sessionDecrypt(key, msg) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(msg.iv) }, key, unb64(msg.ct));
  return JSON.parse(DEC.decode(pt));
}

function b64(u8) {
  if (typeof btoa === 'function') { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); }
  return Buffer.from(u8).toString('base64');
}
function unb64(s) {
  if (typeof atob === 'function') { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function generateHandshake() {
  const secret = randomHex(32);
  const salt = randomHex(16);
  return { secret, salt, token: `${secret}:${salt}` };
}

export function parseHandshake(token) {
  const [secret, salt] = token.split(':');
  if (!secret || !salt) throw new Error('invalid handshake token');
  return { secret, salt };
}

export async function createSyncSession(token, vault) {
  const { secret, salt } = typeof token === 'string' ? parseHandshake(token) : token;
  const key = await deriveSessionKey(secret, salt);

  const allKeys = await vault.keys();
  const manifest = new Set(allKeys);

  return {
    key,

    async buildManifestMessage() {
      return sessionEncrypt(key, { type: 'manifest', keys: [...manifest] });
    },

    async handleManifestMessage(msg) {
      const data = await sessionDecrypt(key, msg);
      if (data.type !== 'manifest') throw new Error('expected manifest message');
      const theirKeys = new Set(data.keys);
      const theyNeed = [...manifest].filter(k => !theirKeys.has(k));
      const iNeed = [...theirKeys].filter(k => !manifest.has(k));
      return { theyNeed, iNeed };
    },

    async buildRecordMessages(keys) {
      const messages = [];
      for (const k of keys) {
        const value = await vault.get(k);
        if (value != null) {
          messages.push(await sessionEncrypt(key, { type: 'record', key: k, value }));
        }
      }
      return messages;
    },

    async handleRecordMessage(msg) {
      const data = await sessionDecrypt(key, msg);
      if (data.type !== 'record') throw new Error('expected record message');
      await vault.put(data.key, data.value);
      manifest.add(data.key);
      return data.key;
    },
  };
}

export { deriveSessionKey, sessionEncrypt, sessionDecrypt };
