#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, detectFormat, ingest, ingestToVault, parseAmount, normaliseDate, KNOWN_FORMATS } from './ingest.mjs';
import { Vault } from './vault.mjs';

const SEED = 'correct horse battery staple';

const MONZO_CSV = `Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In
tx_0001,15/03/2026,14:30:00,Card,Tesco,,Groceries,-45.67,GBP,-45.67,GBP,weekly shop,,,,,-45.67,
tx_0002,16/03/2026,09:15:00,Faster Payment,ACME Corp,,Income,2500.00,GBP,2500.00,GBP,invoice payment,,,,,, 2500.00`;

const STARLING_CSV = `Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category
15/03/2026,Sainsburys,CARD PAYMENT,CARD,-32.10,1500.00,GROCERIES
16/03/2026,Client Ltd,INVOICE 42,FASTER_PAYMENT,1200.00,2700.00,INCOME`;

const BARCLAYS_CSV = `Date,Description,Memo,Money out,Money in
15/03/2026,DIRECT DEBIT,VODAFONE LTD,29.00,
16/03/2026,BANK GIRO CREDIT,SALARY,,3200.00`;

const GENERIC_CSV = `Date,Details,Amount
2026-03-15,Coffee Shop,-4.50
2026-03-16,Freelance Payment,800.00`;

test('parseCSV splits headers and rows correctly', () => {
  const { headers, rows } = parseCSV(GENERIC_CSV);
  assert.deepEqual(headers, ['Date', 'Details', 'Amount']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['Date'], '2026-03-15');
  assert.equal(rows[0]['Amount'], '-4.50');
});

test('parseCSV handles quoted fields with commas', () => {
  const csv = 'Name,Amount\n"Smith, John",100.00';
  const { rows } = parseCSV(csv);
  assert.equal(rows[0]['Name'], 'Smith, John');
});

test('parseCSV handles empty input', () => {
  const { rows } = parseCSV('');
  assert.equal(rows.length, 0);
});

test('detectFormat identifies Monzo', () => {
  const { headers } = parseCSV(MONZO_CSV);
  const fmt = detectFormat(headers);
  assert.equal(fmt.name, 'monzo');
});

test('detectFormat identifies Starling', () => {
  const { headers } = parseCSV(STARLING_CSV);
  const fmt = detectFormat(headers);
  assert.equal(fmt.name, 'starling');
});

test('detectFormat identifies Barclays', () => {
  const { headers } = parseCSV(BARCLAYS_CSV);
  const fmt = detectFormat(headers);
  assert.equal(fmt.name, 'barclays');
});

test('detectFormat returns null for unknown formats', () => {
  const fmt = detectFormat(['Foo', 'Bar', 'Baz']);
  assert.equal(fmt, null);
});

test('parseAmount handles currency symbols, commas, and spaces', () => {
  assert.equal(parseAmount('£1,234.56'), 1234.56);
  assert.equal(parseAmount('$-50.00'), -50);
  assert.equal(parseAmount('€ 99.99'), 99.99);
  assert.equal(parseAmount(42), 42);
  assert.equal(parseAmount(null), 0);
  assert.equal(parseAmount('not a number'), 0);
});

test('normaliseDate handles ISO, UK dd/mm/yyyy, and UK short dd/mm/yy', () => {
  assert.equal(normaliseDate('2026-03-15'), '2026-03-15');
  assert.equal(normaliseDate('15/03/2026'), '2026-03-15');
  assert.equal(normaliseDate('15/03/26'), '2026-03-15');
  assert.equal(normaliseDate('1/3/2026'), '2026-03-01');
  assert.equal(normaliseDate(null), null);
});

test('ingest parses Monzo CSV with correct format and summary', () => {
  const result = ingest(MONZO_CSV);
  assert.equal(result.format, 'monzo');
  assert.equal(result.transactions.length, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(result.transactions[0].amount, -45.67);
  assert.equal(result.transactions[1].amount, 2500);
  assert.ok(result.summary.income > 0);
  assert.ok(result.summary.expense < 0);
});

test('ingest parses Starling CSV', () => {
  const result = ingest(STARLING_CSV);
  assert.equal(result.format, 'starling');
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].description, 'Sainsburys');
});

test('ingest parses Barclays CSV with Money in/out columns', () => {
  const result = ingest(BARCLAYS_CSV);
  assert.equal(result.format, 'barclays');
  assert.equal(result.transactions.length, 2);
  assert.ok(result.transactions[0].amount < 0, 'money out is negative');
  assert.ok(result.transactions[1].amount > 0, 'money in is positive');
});

test('ingest falls back to generic format for unknown CSVs', () => {
  const result = ingest(GENERIC_CSV);
  assert.equal(result.format, 'generic');
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].amount, -4.50);
});

test('ingestToVault encrypts transactions into the vault', async () => {
  const v = await new Vault().open(SEED);
  const manifest = await ingestToVault(v, MONZO_CSV, 'test-batch');
  assert.equal(manifest.count, 2);
  assert.equal(manifest.format, 'monzo');
  assert.equal(manifest.id, 'test-batch');

  const tx0 = await v.get('tx-test-batch-00000');
  assert.equal(tx0.amount, -45.67);
  assert.equal(tx0._batch, 'test-batch');
  assert.equal(tx0.raw, undefined, 'raw row data is NOT stored in vault');

  const storedManifest = await v.get('manifest-test-batch');
  assert.equal(storedManifest.count, 2);
});

test('ingestToVault data is encrypted at rest', async () => {
  const { memoryAdapter } = await import('./vault.mjs');
  const adapter = memoryAdapter();
  const v = await new Vault({ adapter }).open(SEED);
  await ingestToVault(v, MONZO_CSV, 'enc-test');
  const stored = JSON.stringify(await adapter.get('tx-enc-test-00000'));
  assert.ok(!stored.includes('Tesco'), 'transaction description must not leak');
  assert.ok(!stored.includes('45.67'), 'transaction amount must not leak');
});
