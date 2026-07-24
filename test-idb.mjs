#!/usr/bin/env node
// Node-side contract for the IndexedDB adapter. The storage round-trip itself runs in a real
// browser (Node has no IndexedDB); what IS testable here is the guard behaviour — the module must
// detect that IndexedDB is absent and refuse to open, rather than throwing an opaque error or
// silently returning a broken adapter. That guard is exactly what stops the app from pretending it
// has a persistent store when it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idbAvailable, openIdbAdapter } from './idb-adapter.mjs';

test('idbAvailable reports false in stock Node (no IndexedDB global)', () => {
  assert.equal(typeof idbAvailable, 'function');
  assert.equal(idbAvailable(), false);
});

test('openIdbAdapter refuses to open when IndexedDB is unavailable', async () => {
  await assert.rejects(() => openIdbAdapter('konomium-vault'), /IndexedDB is unavailable/);
});

test('the adapter contract shape matches memoryAdapter (get/set/delete/keys/clear present in source)', async () => {
  // Structural check against the source so a rename of the adapter interface is caught here even
  // though the live object can only be built in a browser.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./idb-adapter.mjs', import.meta.url), 'utf8');
  for (const method of ['async get(', 'async set(', 'async delete(', 'async keys(', 'async clear(']) {
    assert.ok(src.includes(method), `adapter must expose ${method}`);
  }
});
