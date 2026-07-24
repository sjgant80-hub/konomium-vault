// ════════════════════════════════════════════════════════════════
// konomium-vault · an offline-first, AES-GCM-256 encrypted sovereign store
//
// The data lives on the user's device, encrypted at rest. The browser holds an encrypted vault;
// the user holds the key (a master seed). Nothing leaves the machine unless the user exports it.
//
// Honest scope — what this IS, so no one relies on what it isn't:
//   • Real AES-GCM 256 confidentiality + integrity at rest: every record VALUE is ciphertext (a
//     stolen disk / browser-file scan reveals encrypted amounts and descriptions, not the figures).
//     Record KEYS/ids are stored in cleartext (so keep them non-sensitive, e.g. "tx-<batch>-00001").
//     Authenticated: tampering with a value is detected on decrypt.
//   • Local, user-initiated erasure (`erase`, `purge`) — the data-subject deletion primitive done
//     the honest way: the OWNER deletes their OWN data on their OWN device. There is deliberately
//     NO remote endpoint that lets an outside party trigger a wipe.
//   • A portable encrypted export for cold-storage backup / resurrection on a new machine.
//   It does NOT make you exempt from GDPR or any law — you are still the data controller. It makes
//   your obligations *cheaper to meet* (local data, one-call erasure, no central breach surface).
//   That is a real advantage; "immunity" is not, and this module never claims it.
//
// Web Crypto only (browser + Node >= 20). Storage-agnostic: the crypto core is decoupled from the
// store, so it is fully testable without IndexedDB. Zero dependencies.
// ════════════════════════════════════════════════════════════════

const subtle = globalThis.crypto?.subtle;
if (!subtle) throw new Error('konomium-vault: Web Crypto (crypto.subtle) unavailable — needs a browser or Node >= 20');

const ENCoder = new TextEncoder();
const DECoder = new TextDecoder();

export const VAULT_FORMAT = 'konomium-vault-v1';
export const KDF_ITERATIONS = 600_000;      // PBKDF2-SHA256 rounds — OWASP 2023 floor. Stored per-vault
                                            // in meta, so older exports still open at their own count.
const KEY_ALGO = { name: 'AES-GCM', length: 256 };
const IV_BYTES = 12;                         // 96-bit nonce, fresh per record (never reused with a key)
const SALT_BYTES = 16;
const META_KEY = '__vault_meta__';           // reserved store key holding salt + a seed-check token
const CHECK_PLAINTEXT = 'konomium-vault-open-check';

export function randomBytes(n) { return globalThis.crypto.getRandomValues(new Uint8Array(n)); }

// portable base64 (browser btoa/atob and Node Buffer both covered)
const b64 = {
  enc(u8) {
    if (typeof btoa === 'function') { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); }
    return Buffer.from(u8).toString('base64');
  },
  dec(str) {
    if (typeof atob === 'function') { const bin = atob(str); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
    return new Uint8Array(Buffer.from(str, 'base64'));
  },
};

// ── crypto core (pure, no storage) ─────────────────────────────────────────
export async function deriveKey(masterSeed, salt, iterations = KDF_ITERATIONS) {
  if (typeof masterSeed !== 'string' || masterSeed.length < 8) throw new Error('master seed must be a string of at least 8 characters');
  const base = await subtle.importKey('raw', ENCoder.encode(masterSeed), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, KEY_ALGO, false, ['encrypt', 'decrypt']);
}

// Encrypt any JSON-serialisable value → { iv, ct } (base64). A fresh random IV per call, so two
// encryptions of the same value differ — required for AES-GCM safety and a real confidentiality test.
export async function encrypt(key, value) {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, ENCoder.encode(JSON.stringify(value))));
  return { iv: b64.enc(iv), ct: b64.enc(ct) };
}

// Decrypt { iv, ct } → the original value. Throws if the key is wrong or the ciphertext was
// tampered with (GCM authentication tag failure) — integrity is not optional.
export async function decrypt(key, record) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(record.iv) }, key, b64.dec(record.ct));
  return JSON.parse(DECoder.decode(pt));
}

// ── storage adapters ───────────────────────────────────────────────────────
// The default is in-memory (works everywhere, keeps the core testable). A browser build supplies an
// IndexedDB adapter with the same shape (see idb-adapter.mjs).
export function memoryAdapter() {
  const m = new Map();
  return {
    async get(id) { return m.has(id) ? m.get(id) : null; },
    async set(id, v) { m.set(id, v); },
    async delete(id) { m.delete(id); },
    async keys() { return [...m.keys()]; },
    async clear() { m.clear(); },
  };
}

// ── the Vault ──────────────────────────────────────────────────────────────
export class Vault {
  constructor({ adapter = memoryAdapter(), iterations = KDF_ITERATIONS } = {}) {
    this.adapter = adapter;
    this.iterations = iterations;
    this.key = null;
    this.opened = false;
  }

  #assert() { if (!this.opened) throw new Error('vault is not open — call open(masterSeed) first'); }

  // Open (or initialise) the vault with the user's master seed. On first open, mints a salt + a
  // seed-check token. On later opens, verifies the seed by decrypting that token — a wrong seed is
  // rejected here rather than silently returning garbage.
  async open(masterSeed) {
    let meta = await this.adapter.get(META_KEY);
    if (!meta) {
      const salt = randomBytes(SALT_BYTES);
      const key = await deriveKey(masterSeed, salt, this.iterations);
      meta = { format: VAULT_FORMAT, salt: b64.enc(salt), iterations: this.iterations, check: await encrypt(key, CHECK_PLAINTEXT) };
      await this.adapter.set(META_KEY, meta);
      this.key = key;
    } else {
      const key = await deriveKey(masterSeed, b64.dec(meta.salt), meta.iterations || this.iterations);
      try {
        if (await decrypt(key, meta.check) !== CHECK_PLAINTEXT) throw new Error('mismatch');
      } catch {
        throw new Error('wrong master seed — the vault could not be unlocked');
      }
      this.key = key;
    }
    this.opened = true;
    return this;
  }

  async put(id, value) { this.#assert(); if (id === META_KEY) throw new Error('reserved key'); await this.adapter.set(id, await encrypt(this.key, value)); }

  async get(id) { this.#assert(); const r = await this.adapter.get(id); return r ? decrypt(this.key, r) : null; }

  async has(id) { this.#assert(); return (await this.adapter.get(id)) != null; }

  // GDPR data-subject erasure — local, user-initiated. The owner deletes their own record.
  async erase(id) { this.#assert(); await this.adapter.delete(id); }

  // Wipe the entire vault (record of erasure by destruction). Local and total.
  async purge() { await this.adapter.clear(); this.key = null; this.opened = false; }

  async keys() { this.#assert(); return (await this.adapter.keys()).filter(k => k !== META_KEY); }

  // Cold-storage export: the whole encrypted vault as a portable blob. Records are already
  // ciphertext; the master seed is NOT included, so the file is safe to keep on a USB stick.
  async export() {
    this.#assert();
    const out = { format: VAULT_FORMAT, meta: await this.adapter.get(META_KEY), records: {} };
    for (const k of await this.keys()) out.records[k] = await this.adapter.get(k);
    return out;
  }

  // Resurrect a vault from an exported blob on a new machine. Requires the same master seed; a wrong
  // seed is rejected by open()'s check.
  static async import(blob, masterSeed, { adapter = memoryAdapter() } = {}) {
    if (!blob || blob.format !== VAULT_FORMAT || !blob.meta) throw new Error('not a konomium-vault export');
    await adapter.set(META_KEY, blob.meta);
    for (const [k, v] of Object.entries(blob.records || {})) await adapter.set(k, v);
    return new Vault({ adapter }).open(masterSeed);
  }
}

export default Vault;
