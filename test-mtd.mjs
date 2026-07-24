#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVATReturn, formatForHMRC, classifyTransaction, prepareSubmission, VAT_RATES } from './mtd.mjs';
import { Vault } from './vault.mjs';

const SEED = 'correct horse battery staple';
const PERIOD = { from: '2026-01-01', to: '2026-03-31', key: '26A1' };

const SALES = [
  { date: '2026-01-15', amount: 1200.00, description: 'Invoice 001' },
  { date: '2026-02-10', amount: 600.00, description: 'Invoice 002' },
];

const PURCHASES = [
  { date: '2026-01-20', amount: -120.00, description: 'Office supplies' },
  { date: '2026-03-01', amount: -60.00, description: 'Fuel for van' },
];

test('classifyTransaction marks positive amounts as output/sales', () => {
  const cls = classifyTransaction({ amount: 100, description: 'Client payment' });
  assert.equal(cls.type, 'output');
  assert.equal(cls.vatRate, 'standard');
});

test('classifyTransaction marks negative amounts as input/purchases', () => {
  const cls = classifyTransaction({ amount: -50, description: 'Stationery' });
  assert.equal(cls.type, 'input');
  assert.equal(cls.vatRate, 'standard');
});

test('classifyTransaction detects fuel as standard-rate input', () => {
  const cls = classifyTransaction({ amount: -60, description: 'Petrol at BP' });
  assert.equal(cls.type, 'input');
  assert.equal(cls.vatRate, 'standard');
});

test('classifyTransaction detects insurance as exempt', () => {
  const cls = classifyTransaction({ amount: -30, description: 'Van insurance premium' });
  assert.equal(cls.type, 'input');
  assert.equal(cls.vatRate, 'exempt');
});

test('VAT_RATES has the correct UK rates', () => {
  assert.equal(VAT_RATES.standard, 0.20);
  assert.equal(VAT_RATES.reduced, 0.05);
  assert.equal(VAT_RATES.zero, 0.00);
  assert.equal(VAT_RATES.exempt, null);
});

test('computeVATReturn calculates correct boxes for simple transactions', () => {
  const txs = [...SALES, ...PURCHASES];
  const result = computeVATReturn(txs, PERIOD);

  assert.ok(result.boxes.box1 > 0, 'box1 (VAT on sales) should be positive');
  assert.ok(result.boxes.box4 > 0, 'box4 (VAT reclaimed) should be positive');
  assert.equal(result.boxes.box5, Math.abs(result.boxes.box1 - result.boxes.box4), 'box5 = |box1 - box4|');
  assert.ok(result.boxes.box6 > 0, 'box6 (total sales ex VAT) should be positive');
  assert.ok(result.boxes.box7 > 0, 'box7 (total purchases ex VAT) should be positive');
});

test('computeVATReturn filters by period', () => {
  const txs = [
    { date: '2026-01-15', amount: 1200.00, description: 'In period' },
    { date: '2025-12-15', amount: 5000.00, description: 'Before period' },
    { date: '2026-04-15', amount: 3000.00, description: 'After period' },
  ];
  const result = computeVATReturn(txs, PERIOD);
  assert.equal(result.lineCount, 1);
});

test('computeVATReturn with no transactions returns zero boxes', () => {
  const result = computeVATReturn([], PERIOD);
  assert.equal(result.boxes.box1, 0);
  assert.equal(result.boxes.box4, 0);
  assert.equal(result.boxes.box5, 0);
  assert.equal(result.lineCount, 0);
});

test('computeVATReturn standard rate: £1200 gross = £1000 net + £200 VAT', () => {
  const result = computeVATReturn([{ date: '2026-02-01', amount: 1200, description: 'sale' }], PERIOD);
  assert.equal(result.boxes.box1, 200);
  assert.equal(result.boxes.box6, 1000);
});

test('formatForHMRC produces the correct HMRC API shape', () => {
  const vatReturn = computeVATReturn([...SALES, ...PURCHASES], PERIOD);
  const payload = formatForHMRC(vatReturn);
  assert.equal(payload.periodKey, '26A1');
  assert.equal(payload.finalised, true);
  assert.equal(typeof payload.vatDueSales, 'number');
  assert.equal(typeof payload.vatReclaimedCurrPeriod, 'number');
  assert.equal(typeof payload.netVatDue, 'number');
  assert.equal(typeof payload.totalValueSalesExVAT, 'number');
  assert.equal(typeof payload.totalValuePurchasesExVAT, 'number');
});

test('prepareSubmission reads transactions from vault and builds payload', async () => {
  const v = await new Vault().open(SEED);
  await v.put('tx-q1-00000', { date: '2026-01-15', amount: 1200, description: 'Invoice 001' });
  await v.put('tx-q1-00001', { date: '2026-02-01', amount: -120, description: 'Supplies' });
  await v.put('non-tx-key', { note: 'this is not a transaction' });

  const result = await prepareSubmission(v, PERIOD);
  assert.equal(result.vatReturn.lineCount, 2);
  assert.ok(result.hmrcPayload.vatDueSales > 0);
  assert.equal(result.submit, null, 'no transport injected = no submit fn');
});

test('prepareSubmission with injected transport calls it', async () => {
  const v = await new Vault().open(SEED);
  await v.put('tx-q1-00000', { date: '2026-01-15', amount: 600, description: 'Invoice' });

  let called = false;
  const result = await prepareSubmission(v, PERIOD, {
    transport: payload => { called = true; return { ok: true, correlationId: 'test-123' }; },
  });
  const response = result.submit();
  assert.ok(called, 'transport was invoked');
  assert.equal(response.correlationId, 'test-123');
});
