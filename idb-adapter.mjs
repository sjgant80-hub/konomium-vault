// konomium-vault · idb-adapter.mjs — persistent IndexedDB storage adapter (browser)
//
// Same interface as memoryAdapter() in vault.mjs (get/set/delete/keys/clear), but the data
// survives page reloads, tab closes, and reboots. This is the adapter the browser app MUST use —
// without it the vault is an in-memory Map that evaporates on refresh (which defeats the whole
// point of an "at rest" store). Zero dependencies: raw IndexedDB, promise-wrapped.
//
// The records stored here are ALREADY AES-GCM ciphertext (the Vault encrypts before it calls the
// adapter). IndexedDB never sees plaintext, and the master seed is never persisted.
//
// Browser-only: IndexedDB does not exist in stock Node, so this module guards with idbAvailable()
// and the Node-side behaviour (the guard + the thrown error) is what test-idb.mjs verifies. The
// storage round-trip is verified in a real browser, not mocked.

const DB_VERSION = 1;
const STORE = 'vault';

export function idbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

export async function openIdbAdapter(dbName = 'konomium-vault') {
  if (!idbAvailable()) throw new Error('IndexedDB is unavailable in this environment — cannot open a persistent adapter');

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error(`could not open IndexedDB database "${dbName}"`));
    req.onblocked = () => reject(new Error('IndexedDB open blocked — another tab may hold an older version'));
  });

  const store = mode => db.transaction(STORE, mode).objectStore(STORE);

  return {
    async get(id) {
      const r = await promisify(store('readonly').get(id));
      return r === undefined ? null : r;
    },
    async set(id, value) {
      await promisify(store('readwrite').put(value, id));
    },
    async delete(id) {
      await promisify(store('readwrite').delete(id));
    },
    async keys() {
      const r = await promisify(store('readonly').getAllKeys());
      return r.map(String);
    },
    async clear() {
      await promisify(store('readwrite').clear());
    },
    // For a total, honest GDPR purge: drop the whole database file, not just its contents.
    async destroy() {
      db.close();
      await promisify(indexedDB.deleteDatabase(dbName));
    },
    _dbName: dbName,
  };
}

export default openIdbAdapter;
