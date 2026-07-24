#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVATReturn, formatForHMRC, classifyTransaction, suggestVatClass, prepareSubmission, VAT_RATES } from './mtd.mjs';
import { Vault } from './vault.mjs';

const SEED = 'correct horse battery staple';
const PERIOD = { from: '2026-01-01', to: '2026-03-31', key: '26A1' };

test('classifyTransaction marks positive amounts as standard-rate sales', () => {
  const cls = classifyTransaction({ amount: 100, description: 'Client payment' });
  assert.deepEqual(cls, { type: 'output', vatRate: 'standard' });
});

test('classifyTransaction marks a non-sale inflow (loan/transfer) as outside-scope', () => {
  assert.equal(classifyTransaction({ amount: 5000, description: 'Bank loan drawdown' }).vatRate, 'outside-scope');
  assert.equal(classifyTransaction({ amount: 200, description: 'Transfer from savings' }).vatRate, 'outside-scope');
});

test('classifyTransaction NEVER auto-reclaims: every purchase defaults to outside-scope', () => {
  // This is the load-bearing safety property — the tool must not invent reclaimable VAT.
  for (const desc of ['Stationery', 'Fuel at BP', 'Van insurance', 'Salary to staff', 'Owner drawings', 'Loan repayment']) {
    const cls = classifyTransaction({ amount: -100, description: desc });
    assert.equal(cls.type, 'input');
    assert.equal(cls.vatRate, 'outside-scope', `${desc} must NOT auto-reclaim`);
  }
});

test('suggestVatClass offers non-binding hints without changing the numbers', () => {
  assert.equal(suggestVatClass({ amount: -60, description: 'Fuel at BP' }).vatRate, 'standard');
  assert.equal(suggestVatClass({ amount: -30, description: 'Van insurance premium' }).vatRate, 'exempt');
  assert.equal(suggestVatClass({ amount: -2000, description: 'Salary payment' }).vatRate, 'outside-scope');
  assert.equal(suggestVatClass({ amount: 500, description: 'anything positive' }), null);
});

test('VAT_RATES has the correct UK rates', () => {
  assert.equal(VAT_RATES.standard, 0.20);
  assert.equal(VAT_RATES.reduced, 0.05);
  assert.equal(VAT_RATES.zero, 0.00);
  assert.equal(VAT_RATES.exempt, null);
  assert.equal(VAT_RATES['outside-scope'], null);
});

test('the phantom-VAT bug is fixed: wages/drawings/loans reclaim ZERO input VAT', () => {
  const txs = [
    { date: '2026-02-01', amount: -2000, description: 'Salary payment to staff' },
    { date: '2026-02-02', amount: -3000, description: 'Owner drawings' },
    { date: '2026-02-03', amount: -1500, description: 'Loan repayment to bank' },
  ];
  const r = computeVATReturn(txs, PERIOD);
  assert.equal(r.boxes.box4, 0, 'no reclaimable VAT from outside-scope outflows');
  assert.equal(r.boxes.box7, 0, 'outside-scope outflows are not in box7 either');
});

test('explicit tx.vatClass DOES reclaim — user opts in per purchase', () => {
  const txs = [
    { date: '2026-01-15', amount: 1200, description: 'Sale' },
    { date: '2026-01-20', amount: -120, description: 'Office supplies', vatClass: { type: 'input', vatRate: 'standard' } },
  ];
  const r = computeVATReturn(txs, PERIOD);
  assert.equal(r.boxes.box1, 200, 'output VAT on the £1200 sale');
  assert.equal(r.boxes.box4, 20, 'input VAT reclaimed on the explicitly-classified £120 purchase');
  assert.equal(r.boxes.box7, 100, 'net purchase in box7');
});

test('standard rate: £1200 gross sale = £1000 net + £200 VAT', () => {
  const r = computeVATReturn([{ date: '2026-02-01', amount: 1200, description: 'sale' }], PERIOD);
  assert.equal(r.boxes.box1, 200);
  assert.equal(r.boxes.box6, 1000);
});

test('reduced rate (5%): £105 gross = £100 net + £5 VAT', () => {
  const tx = { date: '2026-02-01', amount: 105, description: 'x', vatClass: { type: 'output', vatRate: 'reduced' } };
  const r = computeVATReturn([tx], PERIOD);
  assert.equal(r.boxes.box1, 5);
  assert.equal(r.boxes.box6, 100);
});

test('zero rate: net counts in box6, VAT is zero', () => {
  const tx = { date: '2026-02-01', amount: 500, description: 'books', vatClass: { type: 'output', vatRate: 'zero' } };
  const r = computeVATReturn([tx], PERIOD);
  assert.equal(r.boxes.box1, 0);
  assert.equal(r.boxes.box6, 500);
});

test('exempt input: reclaims 0 VAT but the net still lands in box7', () => {
  const tx = { date: '2026-02-01', amount: -240, description: 'insurance', vatClass: { type: 'input', vatRate: 'exempt' } };
  const r = computeVATReturn([tx], PERIOD);
  assert.equal(r.boxes.box4, 0);
  assert.equal(r.boxes.box7, 240);
});

test('reclaim direction: when box4 > box3 the return is a reclaim, box5 stays positive', () => {
  const txs = [
    { date: '2026-01-10', amount: 120, description: 'small sale' },
    { date: '2026-01-11', amount: -1200, description: 'big purchase', vatClass: { type: 'input', vatRate: 'standard' } },
  ];
  const r = computeVATReturn(txs, PERIOD);
  assert.equal(r.direction, 'reclaim');
  assert.ok(r.boxes.box5 > 0, 'box5 is the absolute difference, always positive');
  assert.equal(r.boxes.box5, Math.abs(r.boxes.box3 - r.boxes.box4));
});

test('box5 equals |box3 - box4| to the penny even at a rounding boundary (no double-round)', () => {
  const txs = [
    { date: '2026-01-01', amount: 100, description: 'sale' },
    { date: '2026-01-02', amount: -100.09, description: 'purchase', vatClass: { type: 'input', vatRate: 'standard' } },
  ];
  const r = computeVATReturn(txs, PERIOD);
  const expected = Math.round(Math.abs(r.boxes.box3 - r.boxes.box4) * 100) / 100;
  assert.equal(r.boxes.box5, expected, 'box5 derived from rounded box3/box4, to the penny');
  assert.equal(r.boxes.box5, 0.01, 'the concrete value HMRC expects');
});

test('computeVATReturn filters by period and excludes unplaceable dates', () => {
  const txs = [
    { date: '2026-01-15', amount: 1200, description: 'In period' },
    { date: '2025-12-15', amount: 5000, description: 'Before period' },
    { date: '2026-04-15', amount: 3000, description: 'After period' },
    { date: null, amount: 999, description: 'No date — unplaceable' },
  ];
  const r = computeVATReturn(txs, PERIOD);
  assert.equal(r.lineCount, 1);
  assert.equal(r.boxes.box6, 1000);
});

test('empty input yields all-zero boxes', () => {
  const r = computeVATReturn([], PERIOD);
  assert.equal(r.boxes.box1, 0);
  assert.equal(r.boxes.box4, 0);
  assert.equal(r.boxes.box5, 0);
  assert.equal(r.lineCount, 0);
});

test('formatForHMRC maps EACH box to the correct HMRC field (exact values, not just types)', () => {
  // A deliberately asymmetric return so every field has a distinct value — a transposition in the
  // mapping would change at least one assertion. This kills the old typeof-only theatre.
  const txs = [
    { date: '2026-01-05', amount: 600, description: 'sale' },                                              // box1=100, box6=500
    { date: '2026-01-06', amount: -60, description: 'purchase', vatClass: { type: 'input', vatRate: 'standard' } }, // box4=10, box7=50
  ];
  const vatReturn = computeVATReturn(txs, PERIOD);
  const b = vatReturn.boxes;
  const p = formatForHMRC(vatReturn);
  assert.equal(p.periodKey, '26A1');
  assert.equal(p.finalised, true);
  assert.equal(p.vatDueSales, b.box1);
  assert.equal(p.vatDueAcquisitions, b.box2);
  assert.equal(p.totalVatDue, b.box3);
  assert.equal(p.vatReclaimedCurrPeriod, b.box4);
  assert.equal(p.netVatDue, b.box5);
  assert.equal(p.totalValueSalesExVAT, b.box6);
  assert.equal(p.totalValuePurchasesExVAT, b.box7);
  // and the values are genuinely distinct, so the mapping is actually constrained
  assert.notEqual(b.box1, b.box4);
  assert.notEqual(b.box6, b.box7);
});

test('prepareSubmission reads tx- keys from the vault and builds the payload', async () => {
  const v = await new Vault().open(SEED);
  await v.put('tx-q1-00000', { date: '2026-01-15', amount: 1200, description: 'Invoice 001' });
  await v.put('tx-q1-00001', { date: '2026-02-01', amount: -120, description: 'Supplies', vatClass: { type: 'input', vatRate: 'standard' } });
  await v.put('non-tx-key', { note: 'not a transaction' });

  const result = await prepareSubmission(v, PERIOD);
  assert.equal(result.vatReturn.lineCount, 2);
  assert.equal(result.hmrcPayload.vatDueSales, 200);
  assert.equal(result.hmrcPayload.vatReclaimedCurrPeriod, 20);
  assert.equal(result.submit, null, 'no transport injected = no submit fn');
});

test('prepareSubmission with injected transport calls it', async () => {
  const v = await new Vault().open(SEED);
  await v.put('tx-q1-00000', { date: '2026-01-15', amount: 600, description: 'Invoice' });
  let called = false;
  const result = await prepareSubmission(v, PERIOD, {
    transport: () => { called = true; return { ok: true, correlationId: 'test-123' }; },
  });
  const response = result.submit();
  assert.ok(called);
  assert.equal(response.correlationId, 'test-123');
});
