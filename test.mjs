#!/usr/bin/env node
// ═══ KONOMIUM-VAULT TEST SUITE ═══
// Real crypto against the actual Web Crypto engine (Node >= 20) + the in-memory adapter — no mock
// of the code under test. The load-bearing tests: the stored bytes leak no plaintext, a wrong seed
// cannot open the vault, and tampering is caught by the GCM auth tag.
// Usage: node --test test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vault, memoryAdapter, encrypt, decrypt, deriveKey, randomBytes, VAULT_FORMAT } from './vault.mjs';

const SEED = 'correct horse battery staple';
const INVOICE = { id: 'mercor-2026-q1', gross: 5000, currency: 'GBP', desc: 'sprint invoice' };

test('round trip — a put value comes back byte-equal', async () => {
  const v = await new Vault().open(SEED);
  await v.put('inv1', INVOICE);
  assert.deepEqual(await v.get('inv1'), INVOICE);
  assert.equal(await v.get('missing'), null);
});

test('confidentiality — the stored record is ciphertext, never the plaintext', async () => {
  const adapter = memoryAdapter();
  const v = await new Vault({ adapter }).open(SEED);
  await v.put('inv1', INVOICE);
  const stored = JSON.stringify(await adapter.get('inv1'));
  assert.ok(!stored.includes('mercor'), 'the invoice id must not appear in storage');
  assert.ok(!stored.includes('5000'), 'the amount must not appear in storage');
  assert.match(stored, /"iv":/); assert.match(stored, /"ct":/);
});

test('a wrong master seed cannot open an existing vault', async () => {
  const adapter = memoryAdapter();
  await (await new Vault({ adapter }).open(SEED)).put('inv1', INVOICE);
  await assert.rejects(() => new Vault({ adapter }).open('wrong seed entirely'), /wrong master seed/);
});

test('tampering is caught — a flipped ciphertext byte fails the auth tag', async () => {
  const key = await deriveKey(SEED, randomBytes(16), 50_000);
  const rec = await encrypt(key, INVOICE);
  const bytes = atobBytes(rec.ct); bytes[bytes.length - 1] ^= 0xff; rec.ct = btoaBytes(bytes);
  await assert.rejects(() => decrypt(key, rec), 'a tampered record must not decrypt');
});

test('encryption is non-deterministic — same value, different ciphertext (fresh IV)', async () => {
  const key = await deriveKey(SEED, randomBytes(16), 50_000);
  const a = await encrypt(key, INVOICE), b = await encrypt(key, INVOICE);
  assert.notEqual(a.iv, b.iv, 'each encryption uses a fresh IV');
  assert.notEqual(a.ct, b.ct, 'ciphertext differs across encryptions');
  assert.deepEqual(await decrypt(key, a), await decrypt(key, b), 'both still decrypt to the same value');
});

test('key derivation is deterministic for a given seed+salt (so import can reopen)', async () => {
  const salt = randomBytes(16);
  const k1 = await deriveKey(SEED, salt, 50_000);
  const k2 = await deriveKey(SEED, salt, 50_000);
  const rec = await encrypt(k1, INVOICE);
  assert.deepEqual(await decrypt(k2, rec), INVOICE, 'a key re-derived from the same seed+salt decrypts');
});

test('GDPR erasure — local, user-initiated deletion of a single record', async () => {
  const v = await new Vault().open(SEED);
  await v.put('client-a', { name: 'A' });
  await v.put('client-b', { name: 'B' });
  await v.erase('client-a');
  assert.equal(await v.get('client-a'), null);
  assert.deepEqual(await v.get('client-b'), { name: 'B' });
  assert.deepEqual(await v.keys(), ['client-b']);
});

test('purge wipes the whole vault and locks it', async () => {
  const v = await new Vault().open(SEED);
  await v.put('x', { a: 1 });
  await v.purge();
  assert.equal(v.opened, false);
  await assert.rejects(() => v.get('x'), /not open/);
});

test('cold-storage export omits the seed and re-imports on a fresh adapter', async () => {
  const v = await new Vault().open(SEED);
  await v.put('inv1', INVOICE);
  await v.put('inv2', { id: 'starlink', gross: -75 });
  const blob = await v.export();
  assert.equal(blob.format, VAULT_FORMAT);
  assert.ok(!JSON.stringify(blob).includes('correct horse'), 'the master seed is never in the export');

  const restored = await Vault.import(blob, SEED, { adapter: memoryAdapter() });
  assert.deepEqual(await restored.get('inv1'), INVOICE);
  assert.deepEqual(await restored.get('inv2'), { id: 'starlink', gross: -75 });
});

test('an export cannot be opened with the wrong seed', async () => {
  const v = await new Vault().open(SEED);
  await v.put('inv1', INVOICE);
  const blob = await v.export();
  await assert.rejects(() => Vault.import(blob, 'not the seed', { adapter: memoryAdapter() }), /wrong master seed/);
});

test('a too-short seed is refused', async () => {
  await assert.rejects(() => new Vault().open('short'), /at least 8/);
});

// tiny base64<->bytes helpers for the tamper test (mirror the module's portable pair)
function atobBytes(s) { const bin = (typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function btoaBytes(u) { if (typeof btoa === 'function') { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); } return Buffer.from(u).toString('base64'); }
