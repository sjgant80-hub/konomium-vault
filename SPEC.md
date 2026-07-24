# konomium-vault · design note

> Spec: **konomium-vault-spec-v1**. The engineering contract of this module.

## What it is

An offline-first, AES-GCM-256 encrypted sovereign store. The data lives on the user's device,
encrypted at rest. The browser holds the ciphertext; the user holds the key (a master seed).
Nothing leaves the machine unless the user exports it.

## Surface

`vault.mjs` exports:

- `Vault` (class) — the encrypted store. `open(seed)`, `put(id, value)`, `get(id)`, `has(id)`,
  `erase(id)`, `purge()`, `keys()`, `export()`, `static import(blob, seed, opts)`.
- `memoryAdapter` (function) — in-memory storage adapter for testing.
- `encrypt` / `decrypt` (functions) — AES-GCM-256 crypto core (pure, no storage).
- `deriveKey` (function) — PBKDF2-SHA256 key derivation from seed + salt.
- `randomBytes` (function) — CSPRNG wrapper.
- `VAULT_FORMAT` (string) — wire format version tag.
- `KDF_ITERATIONS` (number) — PBKDF2 iteration count (250 000).

## Invariants

1. **Confidentiality.** Stored records are ciphertext — the plaintext never appears in storage.
   Verified: the confidentiality test asserts no substring of the value leaks into the adapter.
2. **Integrity.** AES-GCM's authentication tag detects any tampering. A flipped ciphertext byte
   causes decrypt to throw, not return garbage. Verified in `test.mjs`.
3. **Non-deterministic encryption.** A fresh random IV per `encrypt()` call — two encryptions of
   the same value produce different ciphertext. Required for AES-GCM safety.
4. **Deterministic key derivation.** Same seed + same salt → same key. This is what makes cold-storage
   import work: the user's seed is the only secret.
5. **Wrong-seed rejection.** A wrong master seed is caught on `open()` via a seed-check token, not
   silently returning garbage on later `get()` calls.
6. **Local erasure.** `erase()` and `purge()` are local, user-initiated. There is no remote endpoint
   that lets an outside party trigger a wipe. Deletion is the owner's action, never a stranger's.
7. **Honest scope.** The module never claims GDPR "immunity" or AI-Act exemption. It makes privacy
   obligations cheaper to meet (local data, one-call erasure, no central breach surface). That is
   a real advantage; "immunity" is not and this module never claims it.

## Verification

`node --test test.mjs` — 11 real crypto tests against the actual Web Crypto engine. No mock of the
code under test. CI runs it on every push.
