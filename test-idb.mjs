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


// ─── the fake-IndexedDB harness (estate bring-up) ───
// The header above says the round-trip is "verified in a real browser, not mocked" — which meant
// the mutation gate could break every branch below the guard and no test would notice. The fake is
// ten lines of request objects, and it makes every branch in this file falsifiable in Node.

function fakeIDB({ failGet = false, failOpen = false, bareErrors = false } = {}) {
  const dbs = new Map();
  const mkReq = (result, error) => {
    const r = { result, error };
    queueMicrotask(() => (error !== undefined || (failGet && r._isGet))
      ? r.onerror && r.onerror()
      : r.onsuccess && r.onsuccess());
    return r;
  };
  return {
    open(dbName) {
      const req = {};
      queueMicrotask(() => {
        if (failOpen) {
          if (!bareErrors) req.error = new Error('open exploded');
          req.onerror && req.onerror();
          return;
        }
        if (!dbs.has(dbName)) dbs.set(dbName, new Map());
        const data = dbs.get(dbName);
        req.result = {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction: () => ({
            objectStore: () => ({
              get: (id) => {
                const r = mkReq(data.get(id));
                r._isGet = true;
                if (failGet && !bareErrors) r.error = new Error('get exploded');
                return r;
              },
              put: (v, id) => { data.set(id, v); return mkReq(undefined); },
              delete: (id) => { data.delete(id); return mkReq(undefined); },
              getAllKeys: () => mkReq([...data.keys()]),
              clear: () => { data.clear(); return mkReq(undefined); },
            }),
          }),
        };
        req.onupgradeneeded && req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
    deleteDatabase(dbName) { dbs.delete(dbName); return mkReq(undefined); },
  };
}

const withIDB = async (idb, fn) => {
  globalThis.indexedDB = idb;
  try { return await fn(); } finally { delete globalThis.indexedDB; }
};

test('THE GUARD TELLS THE TRUTH IN EVERY ENVIRONMENT — null is a real browser failure mode', () => {
  globalThis.indexedDB = null;
  try { assert.equal(idbAvailable(), false, 'indexedDB === null reported as available'); }
  finally { delete globalThis.indexedDB; }
  globalThis.indexedDB = fakeIDB();
  try { assert.equal(idbAvailable(), true, 'a present IndexedDB reported as absent'); }
  finally { delete globalThis.indexedDB; }
});

test('A MISSING RECORD IS NULL, NEVER UNDEFINED — vault code tells a cache miss from a non-answer', async () => {
  await withIDB(fakeIDB(), async () => {
    const a = await openIdbAdapter('t1');
    assert.strictEqual(await a.get('nope'), null, 'a missing record came back undefined');
    await a.set('k', 'ciphertext');
    assert.equal(await a.get('k'), 'ciphertext');
  });
});

test('the round-trip holds: set, keys, delete, clear', async () => {
  await withIDB(fakeIDB(), async () => {
    const a = await openIdbAdapter('t2');
    await a.set('a', '1'); await a.set('b', '2');
    assert.deepEqual((await a.keys()).sort(), ['a', 'b']);
    await a.delete('a');
    assert.deepEqual(await a.keys(), ['b']);
    await a.clear();
    assert.deepEqual(await a.keys(), []);
  });
});

test('A FAILED REQUEST WITH NO ERROR OBJECT STILL REJECTS WITH A REASON', async () => {
  // IndexedDB can fire onerror with request.error unset. `req.error || new Error(...)` is all that
  // stands between that and "the vault failed: undefined" — the least actionable sentence possible.
  await withIDB(fakeIDB({ failGet: true, bareErrors: true }), async () => {
    const a = await openIdbAdapter('t3');
    await assert.rejects(() => a.get('k'), /IndexedDB request failed/, 'the fallback reason was lost');
  });
});

test('and a failed request WITH an error keeps the real one', async () => {
  await withIDB(fakeIDB({ failGet: true }), async () => {
    const a = await openIdbAdapter('t4');
    await assert.rejects(() => a.get('k'), /get exploded/, 'the real error was replaced by the fallback');
  });
});

test('a failed OPEN with no error object names the database in its fallback', async () => {
  await withIDB(fakeIDB({ failOpen: true, bareErrors: true }), async () => {
    await assert.rejects(() => openIdbAdapter('the-db'), /could not open IndexedDB database "the-db"/);
  });
});

test('a failed open with a real error keeps it', async () => {
  await withIDB(fakeIDB({ failOpen: true }), async () => {
    await assert.rejects(() => openIdbAdapter('x'), /open exploded/);
  });
});
