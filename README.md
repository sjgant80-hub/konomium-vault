# konomium-vault

**Live:** [sjgant80-hub.github.io/konomium-vault](https://sjgant80-hub.github.io/konomium-vault/)

Offline-first, AES-GCM-256 encrypted sovereign store. Your data on your device, encrypted at rest.
The browser holds the ciphertext; you hold the key.

## Install

```bash
npm install
```

## Test

```bash
npm test
```

## Usage

```js
import { Vault } from './vault.mjs';

const v = await new Vault().open('your master seed here');
await v.put('invoice-001', { gross: 5000, currency: 'GBP' });
const inv = await v.get('invoice-001');
await v.erase('invoice-001');

const backup = await v.export();
const restored = await Vault.import(backup, 'your master seed here');
```

## Honest scope

Real AES-GCM 256 confidentiality + integrity at rest. Local, user-initiated erasure. Portable
encrypted cold-storage export. Zero dependencies — Web Crypto only (browser + Node >= 20).

It does NOT make you exempt from GDPR or any law. It makes your obligations cheaper to meet.
