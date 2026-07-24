// konomium-vault · mtd.mjs — HMRC Making Tax Digital bridge (d=3, the voice)
// Computes VAT returns from vault transactions, formats them for HMRC's MTD API.
// The module prepares the submission payload; the actual HTTP call is injected
// (so it can be tested without hitting HMRC, and the browser build can use fetch
// while a Node build can use its own transport).
//
// Honest scope: this prepares a VAT return from transaction data. It does NOT
// do tax advice, does not determine your VAT scheme, does not know your business
// rules. You check the numbers; you press submit. This is a filing tool, not
// an accountant.

const VAT_RATE_STANDARD = 0.20;
const VAT_RATE_REDUCED = 0.05;
const VAT_RATE_ZERO = 0.00;

export const VAT_RATES = {
  standard: VAT_RATE_STANDARD,
  reduced: VAT_RATE_REDUCED,
  zero: VAT_RATE_ZERO,
  exempt: null,
};

export function classifyTransaction(tx) {
  const d = (tx.description || '').toLowerCase();
  const cat = (tx.category || '').toLowerCase();

  if (tx.amount > 0) return { type: 'output', vatRate: 'standard' };

  if (/fuel|petrol|diesel|electric charge/i.test(d)) return { type: 'input', vatRate: 'standard' };
  if (/insurance|finance charge|bank fee/i.test(d)) return { type: 'input', vatRate: 'exempt' };
  if (/child|baby|car seat|energy|gas bill|electric bill/i.test(d)) return { type: 'input', vatRate: 'reduced' };

  return { type: 'input', vatRate: 'standard' };
}

export function computeVATReturn(transactions, period) {
  let totalVatDue = 0;          // Box 1: VAT due on sales
  let vatReclaimedOnInputs = 0; // Box 4: VAT reclaimed on purchases
  let totalSalesExVat = 0;      // Box 6: total sales ex VAT
  let totalPurchasesExVat = 0;  // Box 7: total purchases ex VAT
  const lines = [];

  for (const tx of transactions) {
    if (!isInPeriod(tx.date, period)) continue;

    const cls = tx.vatClass || classifyTransaction(tx);
    const rate = VAT_RATES[cls.vatRate];
    const gross = Math.abs(tx.amount);

    if (cls.type === 'output') {
      const net = rate != null ? gross / (1 + rate) : gross;
      const vat = rate != null ? gross - net : 0;
      totalVatDue += vat;
      totalSalesExVat += net;
      lines.push({ ...tx, cls, net: round2(net), vat: round2(vat) });
    } else {
      const net = rate != null ? gross / (1 + rate) : gross;
      const vat = rate != null ? gross - net : 0;
      vatReclaimedOnInputs += vat;
      totalPurchasesExVat += net;
      lines.push({ ...tx, cls, net: round2(net), vat: round2(vat) });
    }
  }

  const netVatDue = totalVatDue - vatReclaimedOnInputs; // Box 5

  return {
    period,
    boxes: {
      box1: round2(totalVatDue),
      box2: 0,
      box3: round2(totalVatDue),
      box4: round2(vatReclaimedOnInputs),
      box5: round2(Math.abs(netVatDue)),
      box6: Math.round(totalSalesExVat),
      box7: Math.round(totalPurchasesExVat),
      box8: 0,
      box9: 0,
    },
    direction: netVatDue >= 0 ? 'owe' : 'reclaim',
    lineCount: lines.length,
    lines,
  };
}

export function formatForHMRC(vatReturn) {
  return {
    periodKey: vatReturn.period.key || `${vatReturn.period.from}#${vatReturn.period.to}`,
    vatDueSales: vatReturn.boxes.box1,
    vatDueAcquisitions: vatReturn.boxes.box2,
    totalVatDue: vatReturn.boxes.box3,
    vatReclaimedCurrPeriod: vatReturn.boxes.box4,
    netVatDue: vatReturn.boxes.box5,
    totalValueSalesExVAT: vatReturn.boxes.box6,
    totalValuePurchasesExVAT: vatReturn.boxes.box7,
    totalValueGoodsSuppliedExVAT: vatReturn.boxes.box8,
    totalAcquisitionsExVAT: vatReturn.boxes.box9,
    finalised: true,
  };
}

export async function prepareSubmission(vault, period, opts = {}) {
  const allKeys = await vault.keys();
  const txKeys = allKeys.filter(k => k.startsWith('tx-'));
  const transactions = [];

  for (const k of txKeys) {
    const tx = await vault.get(k);
    if (tx) transactions.push(tx);
  }

  const vatReturn = computeVATReturn(transactions, period);
  const hmrcPayload = formatForHMRC(vatReturn);

  return {
    vatReturn,
    hmrcPayload,
    submit: opts.transport
      ? () => opts.transport(hmrcPayload)
      : null,
  };
}

function isInPeriod(dateStr, period) {
  if (!dateStr || !period) return true;
  return dateStr >= period.from && dateStr <= period.to;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
