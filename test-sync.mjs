#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateHandshake, parseHandshake, createSyncSession, deriveSessionKey, sessionEncrypt, sessionDecrypt } from './sync.mjs';
import { Vault, memoryAdapter } from './vault.mjs';

const SEED = 'correct horse battery staple';

test('generateHandshake produces a token with secret:salt format', () => {
  const h = generateHandshake();
  assert.ok(h.secret.length === 64, 'secret is 32 bytes hex');
  assert.ok(h.salt.length === 32, 'salt is 16 bytes hex');
  assert.equal(h.token, `${h.secret}:${h.salt}`);
});

test('parseHandshake round-trips with generateHandshake', () => {
  const h = generateHandshake();
  const parsed = parseHandshake(h.token);
  assert.equal(parsed.secret, h.secret);
  assert.equal(parsed.salt, h.salt);
});

test('parseHandshake rejects invalid tokens', () => {
  assert.throws(() => parseHandshake('nocolon'), /invalid handshake/);
});

test('session encrypt/decrypt round-trips', async () => {
  const key = await deriveSessionKey('test-secret-long-enough', 'test-salt');
  const msg = await sessionEncrypt(key, { hello: 'world' });
  const result = await sessionDecrypt(key, msg);
  assert.deepEqual(result, { hello: 'world' });
});

test('session encryption is non-deterministic (fresh IV)', async () => {
  const key = await deriveSessionKey('test-secret-long-enough', 'test-salt');
  const a = await sessionEncrypt(key, { x: 1 });
  const b = await sessionEncrypt(key, { x: 1 });
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test('wrong key cannot decrypt session message', async () => {
  const key1 = await deriveSessionKey('secret-one-is-long', 'salt1');
  const key2 = await deriveSessionKey('secret-two-is-long', 'salt2');
  const msg = await sessionEncrypt(key1, { data: 'private' });
  await assert.rejects(() => sessionDecrypt(key2, msg));
});

test('two vaults sync — initiator sends records responder lacks', async () => {
  const adapterA = memoryAdapter();
  const adapterB = memoryAdapter();
  const vaultA = await new Vault({ adapter: adapterA }).open(SEED);
  const vaultB = await new Vault({ adapter: adapterB }).open(SEED);

  await vaultA.put('inv-001', { gross: 5000 });
  await vaultA.put('inv-002', { gross: 3000 });
  await vaultB.put('inv-003', { gross: 1000 });

  const handshake = generateHandshake();
  const sessionA = await createSyncSession(handshake, vaultA);
  const sessionB = await createSyncSession(handshake, vaultB);

  const manifestMsgA = await sessionA.buildManifestMessage();
  const diffAtB = await sessionB.handleManifestMessage(manifestMsgA);
  assert.ok(diffAtB.iNeed.includes('inv-001'));
  assert.ok(diffAtB.iNeed.includes('inv-002'));
  assert.ok(diffAtB.theyNeed.includes('inv-003'));

  const recordMsgs = await sessionA.buildRecordMessages(diffAtB.iNeed);
  assert.equal(recordMsgs.length, 2);

  for (const msg of recordMsgs) {
    await sessionB.handleRecordMessage(msg);
  }

  const inv1 = await vaultB.get('inv-001');
  assert.deepEqual(inv1, { gross: 5000 });
  const inv2 = await vaultB.get('inv-002');
  assert.deepEqual(inv2, { gross: 3000 });
});

test('sync records remain encrypted — sync never sees plaintext', async () => {
  const adapterA = memoryAdapter();
  const adapterB = memoryAdapter();
  const vaultA = await new Vault({ adapter: adapterA }).open(SEED);
  const vaultB = await new Vault({ adapter: adapterB }).open(SEED);

  await vaultA.put('secret-doc', { name: 'TopSecret', amount: 99999 });

  const handshake = generateHandshake();
  const sessionA = await createSyncSession(handshake, vaultA);
  const sessionB = await createSyncSession(handshake, vaultB);

  const manifestMsgA = await sessionA.buildManifestMessage();
  const diff = await sessionB.handleManifestMessage(manifestMsgA);
  const recordMsgs = await sessionA.buildRecordMessages(diff.iNeed);

  const rawSyncPayload = JSON.stringify(recordMsgs);
  assert.ok(!rawSyncPayload.includes('TopSecret'), 'plaintext name must not appear in sync wire');
  assert.ok(!rawSyncPayload.includes('99999'), 'plaintext amount must not appear in sync wire');

  for (const msg of recordMsgs) {
    await sessionB.handleRecordMessage(msg);
  }
  const restored = await vaultB.get('secret-doc');
  assert.deepEqual(restored, { name: 'TopSecret', amount: 99999 });
});

test('bidirectional sync — both sides gain what the other has', async () => {
  const adapterA = memoryAdapter();
  const adapterB = memoryAdapter();
  const vaultA = await new Vault({ adapter: adapterA }).open(SEED);
  const vaultB = await new Vault({ adapter: adapterB }).open(SEED);

  await vaultA.put('a-only', { src: 'A' });
  await vaultB.put('b-only', { src: 'B' });

  const handshake = generateHandshake();
  const sessionA = await createSyncSession(handshake, vaultA);
  const sessionB = await createSyncSession(handshake, vaultB);

  const mA = await sessionA.buildManifestMessage();
  const mB = await sessionB.buildManifestMessage();

  const diffA = await sessionA.handleManifestMessage(mB);
  const diffB = await sessionB.handleManifestMessage(mA);

  const fromB = await sessionB.buildRecordMessages(diffA.iNeed);
  for (const msg of fromB) await sessionA.handleRecordMessage(msg);

  const fromA = await sessionA.buildRecordMessages(diffB.iNeed);
  for (const msg of fromA) await sessionB.handleRecordMessage(msg);

  assert.deepEqual(await vaultA.get('b-only'), { src: 'B' });
  assert.deepEqual(await vaultB.get('a-only'), { src: 'A' });
});

test('message-type guards reject a wrong message kind', async () => {
  const vault = await new Vault().open(SEED);
  const handshake = generateHandshake();
  const session = await createSyncSession(handshake, vault);
  const recordMsg = await sessionEncrypt(await deriveSessionKey(handshake.secret, handshake.salt), { type: 'record', key: 'x', value: 1 });
  await assert.rejects(() => session.handleManifestMessage(recordMsg), /expected manifest/);
  const manifestMsg = await sessionEncrypt(await deriveSessionKey(handshake.secret, handshake.salt), { type: 'manifest', keys: [] });
  await assert.rejects(() => session.handleRecordMessage(manifestMsg), /expected record/);
});
