#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KonomiumNode, memoryAdapter } from './node.mjs';

const SEED = 'correct horse battery staple';
const CSV = `Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category
15/01/2026,Client A,INV-001,FASTER_PAYMENT,1200.00,3200.00,INCOME
20/01/2026,Staples,CARD PAYMENT,CARD,-45.00,3155.00,OFFICE
01/02/2026,Client B,INV-002,FASTER_PAYMENT,800.00,3955.00,INCOME
15/02/2026,Shell,FUEL,CARD,-60.00,3895.00,TRANSPORT`;

test('KonomiumNode opens and reports ready', async () => {
  const node = await new KonomiumNode().open(SEED);
  assert.ok(node.opened);
});

test('not-open node throws on operations', async () => {
  const node = new KonomiumNode();
  await assert.rejects(() => node.ingestCSV('x'), /not open/);
  await assert.rejects(() => node.vatReturn({}), /not open/);
  await assert.rejects(() => node.keys(), /not open/);
});

test('ingestCSV ingests transactions and returns a manifest', async () => {
  const node = await new KonomiumNode().open(SEED);
  const manifest = await node.ingestCSV(CSV, 'q1-2026');
  assert.equal(manifest.format, 'starling');
  assert.equal(manifest.count, 4);
  assert.equal(manifest.id, 'q1-2026');
});

test('previewCSV parses without storing anything', async () => {
  const node = new KonomiumNode();
  const preview = node.previewCSV(CSV);
  assert.equal(preview.format, 'starling');
  assert.equal(preview.transactions.length, 4);
});

test('vatReturn computes boxes from ingested data', async () => {
  const node = await new KonomiumNode().open(SEED);
  await node.ingestCSV(CSV, 'q1');
  const period = { from: '2026-01-01', to: '2026-03-31' };
  const result = await node.vatReturn(period);
  assert.ok(result.vatReturn.boxes.box1 > 0, 'sales VAT computed');
  assert.ok(result.vatReturn.boxes.box4 > 0, 'input VAT reclaimed');
  assert.ok(result.hmrcPayload.vatDueSales > 0);
});

test('export and import round-trip the whole node', async () => {
  const node = await new KonomiumNode().open(SEED);
  await node.ingestCSV(CSV, 'export-test');
  const blob = await node.export();

  const restored = await KonomiumNode.import(blob, SEED, { adapter: memoryAdapter() });
  const keys = await restored.keys();
  assert.ok(keys.length > 0);
  const tx = await restored.get('tx-export-test-00000');
  assert.ok(tx.amount !== undefined);
});

test('summary counts transactions, batches, and other records', async () => {
  const node = await new KonomiumNode().open(SEED);
  await node.put('config', { theme: 'dark' });
  await node.ingestCSV(CSV, 'sum-test');
  const s = await node.summary();
  assert.equal(s.transactions, 4);
  assert.equal(s.batches, 1);
  assert.equal(s.otherRecords, 1);
  assert.equal(s.totalRecords, 6);
});

test('initiateSync and joinSync create compatible sessions', async () => {
  const nodeA = await new KonomiumNode().open(SEED);
  const nodeB = await new KonomiumNode().open(SEED);
  await nodeA.put('from-a', { x: 1 });

  const { token, connect } = nodeA.initiateSync();
  assert.ok(token.includes(':'), 'token has secret:salt format');

  const sessionA = await connect();
  const sessionB = await nodeB.joinSync(token);

  const mA = await sessionA.buildManifestMessage();
  const diff = await sessionB.handleManifestMessage(mA);
  assert.ok(diff.iNeed.includes('from-a'));
});

test('purge wipes the node and locks it', async () => {
  const node = await new KonomiumNode().open(SEED);
  await node.put('x', { a: 1 });
  await node.purge();
  assert.equal(node.opened, false);
  await assert.rejects(() => node.get('x'), /not open/);
});

test('erase removes a single record', async () => {
  const node = await new KonomiumNode().open(SEED);
  await node.put('keep', { a: 1 });
  await node.put('remove', { b: 2 });
  await node.erase('remove');
  assert.equal(await node.get('remove'), null);
  assert.deepEqual(await node.get('keep'), { a: 1 });
});
