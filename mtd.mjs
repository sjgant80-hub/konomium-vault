// konomium-vault · mtd.mjs — HMRC Making Tax Digital bridge (d=3, the voice)
// Computes a UK VAT return from vault transactions and formats it for HMRC's MTD API. The module
// prepares the submission payload; the actual HTTP call is INJECTED (opts.transport), so it is
// testable without hitting HMRC and never makes a network call of its own.
//
// Honest scope — and the safety rule that shapes the maths:
//   • This prepares a DRAFT domestic (UK) VAT return. It does not give tax advice, does not know
//     your VAT scheme, and cannot know a transaction's real VAT treatment from a bank line.
//   • It NEVER auto-reclaims input VAT. Every purchase defaults to "outside the scope of VAT"
//     (no reclaim) because OVER-claiming from HMRC is the dangerous direction. To reclaim VAT on a
//     purchase the user classifies it explicitly (tx.vatClass); suggestVatClass() offers a
//     non-binding hint the UI can surface, but it is never applied to the numbers on its own.
//   • Box 2/8/9 are domestic-zero: EU acquisitions, postponed import VAT and reverse-charge are out
//     of scope for this bridge. You check every figure; you press submit. A filing tool, not an accountant.

const VAT_RATE_STANDARD = 0.20;
const VAT_RATE_REDUCED = 0.05;
const VAT_RATE_ZERO = 0.00;

// A rate of `null` means no VAT is charged. 'exempt'/'zero' supplies still count toward the net
// totals (box6/box7); 'outside-scope' items (wages, drawings, loans, tax payments, transfers) are
// not taxable supplies at all and are excluded from EVERY box.
export const VAT_RATES = {
  standard: VAT_RATE_STANDARD,
  reduced: VAT_RATE_REDUCED,
  zero: VAT_RATE_ZERO,
  exempt: null,
  'outside-scope': null,
};

// Inflows that are plainly not sales, so should not attract output VAT by default.
const OUTSIDE_SCOPE_INFLOW = /\b(transfer|loan|capital|dividend|vat refund|refund from hmrc|drawings|interest)\b/i;
// Outflows that are plainly outside the scope of VAT (never reclaimable).
const OUTSIDE_SCOPE_OUTFLOW = /\b(salary|salaries|wage|wages|payroll|paye|national insurance|drawings|dividend|loan|transfer|hmrc|vat payment|corporation tax|pension|mortgage)\b/i;
// Outflows that look like genuine standard-rate business purchases (a SUGGESTION only).
const RECLAIMABLE_HINT = /\b(supplies|stock|equipment|fuel|petrol|diesel|software|subscription|hosting|materials|tools|office|stationery|rent|utilities|hardware)\b/i;
const EXEMPT_HINT = /\b(insurance|finance charge|bank fee|bank charge)\b/i;

// Conservative default classification. Outputs default to standard-rate unless they read as a
// non-sale inflow; inputs ALWAYS default to outside-scope (no reclaim). This is what stops the tool
// from ever inventing reclaimable VAT out of ordinary outgoings.
export function classifyTransaction(tx) {
  const d = tx.description || '';
  if (tx.amount > 0) {
    return OUTSIDE_SCOPE_INFLOW.test(d)
      ? { type: 'output', vatRate: 'outside-scope' }
      : { type: 'output', vatRate: 'standard' };
  }
  return { type: 'input', vatRate: 'outside-scope' };
}

// A NON-BINDING hint for the UI: which purchases might be reclaimable, and why. Never applied to the
// return automatically — the user confirms by setting tx.vatClass. Returns null when there's nothing
// to suggest.
export function suggestVatClass(tx) {
  const d = tx.description || '';
  if (!(tx.amount < 0)) return null;
  if (OUTSIDE_SCOPE_OUTFLOW.test(d)) return { type: 'input', vatRate: 'outside-scope', reason: 'looks like an outside-scope payment (payroll / tax / loan / drawings)' };
  if (EXEMPT_HINT.test(d)) return { type: 'input', vatRate: 'exempt', reason: 'financial / insurance — usually VAT-exempt' };
  if (RECLAIMABLE_HINT.test(d)) return { type: 'input', vatRate: 'standard', reason: 'looks like a standard-rate business purchase — confirm before reclaiming' };
  return null;
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

    // Outside-scope items contribute to no box at all, but are kept in lines[] so the user can see
    // they were considered and reclassify if wrong.
    if (cls.vatRate === 'outside-scope') {
      lines.push({ ...tx, cls, net: 0, vat: 0, outsideScope: true });
      continue;
    }

    const rate = VAT_RATES[cls.vatRate];
    const gross = Math.abs(tx.amount);
    const net = rate != null ? gross / (1 + rate) : gross;
    const vat = rate != null ? gross - net : 0;

    if (cls.type === 'output') { totalVatDue += vat; totalSalesExVat += net; }
    else { vatReclaimedOnInputs += vat; totalPurchasesExVat += net; }

    lines.push({ ...tx, cls, net: round2(net), vat: round2(vat) });
  }

  // Round the box totals FIRST, then derive box5 from the rounded box3/box4 so the submitted payload
  // is internally consistent (HMRC requires box5 == |box3 - box4| to the penny).
  const box1 = round2(totalVatDue);
  const box4 = round2(vatReclaimedOnInputs);
  const box3 = box1;                       // + box2 (domestic-zero)
  const box5 = round2(Math.abs(box3 - box4));

  return {
    period,
    boxes: {
      box1, box2: 0, box3, box4, box5,
      box6: Math.round(totalSalesExVat),
      box7: Math.round(totalPurchasesExVat),
      box8: 0, box9: 0,
    },
    direction: (box3 - box4) >= 0 ? 'owe' : 'reclaim',
    lineCount: lines.length,
    lines,
  };
}

export function formatForHMRC(vatReturn) {
  const b = vatReturn.boxes;
  return {
    periodKey: vatReturn.period.key || `${vatReturn.period.from}#${vatReturn.period.to}`,
    vatDueSales: b.box1,
    vatDueAcquisitions: b.box2,
    totalVatDue: b.box3,
    vatReclaimedCurrPeriod: b.box4,
    netVatDue: b.box5,
    totalValueSalesExVAT: b.box6,
    totalValuePurchasesExVAT: b.box7,
    totalValueGoodsSuppliedExVAT: b.box8,
    totalAcquisitionsExVAT: b.box9,
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
    submit: opts.transport ? () => opts.transport(hmrcPayload) : null,
  };
}

// Only a VALID ISO date can be placed in a period. A missing or non-ISO date is unplaceable and is
// excluded from a bounded period (never lexicographically mis-compared, never counted in every
// period). The ingest layer warns on such dates so they are not lost silently.
function isInPeriod(dateStr, period) {
  if (!period) return true;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  return dateStr >= period.from && dateStr <= period.to;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
