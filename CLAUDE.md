# CLAUDE.md · konomium-vault

Instructions for any agent working in this repository. See `SPEC.md` for the contract.

## Invariants to preserve

1. **The vault is honest.** It encrypts data at rest and makes privacy obligations cheaper to meet.
   It does NOT claim GDPR immunity, AI-Act exemption, or legal bulletproofing. Any code or copy
   that adds such claims is a critical bug.
2. **Local erasure only.** `erase()` and `purge()` are local, user-initiated. There must be no
   remote endpoint, no public API, no unauthenticated route that lets an outside party trigger
   deletion on a user's vault. That would be a remote-wipe DoS, not a compliance feature.
3. **No mock of the code under test.** `test.mjs` imports the real `vault.mjs` and runs real crypto
   against the actual Web Crypto engine. A change that reddens `npm test` does not ship.
4. **Storage-agnostic.** The crypto core is decoupled from the store via the adapter interface.
   `memoryAdapter()` for tests, `idbAdapter()` for browser. Don't couple them.
5. **Zero dependencies.** Web Crypto only (browser + Node >= 20). No npm deps.

## Run

```
npm test
```

CI (`.github/workflows/ci.yml`) runs `npm test` on every push.

## Seam

Estate-facing (vault/sovereign/encryption vocabulary is fine). Do NOT introduce false compliance
claims, "immunity" language, or remote-wipe endpoints. Engineering and honest scope only.
