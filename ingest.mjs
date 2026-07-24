// konomium-vault · ingest.mjs — the mouth (d=1)
// Parses CSV bank statements into normalised transaction records, ready for the vault.
// Handles common UK bank CSV formats (Monzo, Starling, HSBC, Barclays, generic).
// Zero dependencies. No network. The data never leaves the machine.
//
// Integrity rule: a row is NEVER dropped silently. A row whose amount cannot be parsed goes to
// `errors`; a row with no recognisable date is kept but flagged in `warnings`. Nothing valid
// disappears without a signal.

let _batchSeq = 0;

const KNOWN_FORMATS = [
  {
    name: 'monzo',
    detect: h => h.includes('Transaction ID') && h.includes('Amount'),
    map: row => ({
      date: row['Date'] || row['Created'],
      amount: parseAmount(row['Amount']),
      description: row['Description'] || row['Name'],
      category: row['Category'] || null,
      currency: row['Currency'] || 'GBP',
      reference: row['Transaction ID'] || null,
      raw: row,
    }),
  },
  {
    name: 'starling',
    detect: h => h.includes('Counter Party') && h.includes('Amount (GBP)'),
    map: row => ({
      date: row['Date'],
      amount: parseAmount(row['Amount (GBP)'] || row['Amount']),
      description: row['Counter Party'] || row['Reference'],
      category: row['Spending Category'] || null,
      currency: 'GBP',
      reference: row['Reference'] || null,
      raw: row,
    }),
  },
  {
    name: 'hsbc',
    detect: h => h.includes('Transaction Date') && h.includes('Transaction Description'),
    map: row => ({
      date: row['Transaction Date'],
      amount: parseAmount(row['Transaction Amount']),
      description: row['Transaction Description'],
      category: null,
      currency: 'GBP',
      reference: null,
      raw: row,
    }),
  },
  {
    name: 'barclays',
    detect: h => h.includes('Memo') && (h.includes('Amount') || h.includes('Money in') || h.includes('Money out')),
    map: row => {
      let amount;
      if ('Money in' in row && 'Money out' in row) {
        const inAmt = parseAmount(row['Money in']);
        const outAmt = parseAmount(row['Money out']);
        amount = inAmt ? inAmt : (outAmt ? -Math.abs(outAmt) : 0);
      } else {
        amount = parseAmount(row['Amount']);
      }
      return {
        date: row['Date'],
        amount,
        description: row['Memo'] || row['Description'] || row['Subcategory'],
        category: row['Subcategory'] || null,
        currency: 'GBP',
        reference: null,
        raw: row,
      };
    },
  },
];

// Parse a currency/amount cell to a signed Number, or null if it truly cannot be read. Handles UK
// bank/accounting conventions: parentheses for negatives "(50.00)", DR/CR suffixes, a trailing
// minus "100.00-", and currency symbols / thousands separators. Returning null (not 0) is what lets
// ingest() flag an unreadable amount instead of silently storing a £0 transaction.
export function parseAmount(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;

  let str = String(s).trim();
  if (str === '') return null;

  let forcedSign = 0; // 0 = keep the number's own sign, -1/+1 = force it

  const paren = /^\((.*)\)$/.exec(str);
  if (paren) { forcedSign = -1; str = paren[1].trim(); }

  const drcr = /(dr|cr)\s*$/i.exec(str);
  if (drcr) { forcedSign = drcr[1].toLowerCase() === 'dr' ? -1 : 1; str = str.slice(0, drcr.index).trim(); }

  if (/-\s*$/.test(str)) { forcedSign = -1; str = str.replace(/-\s*$/, '').trim(); }

  const cleaned = str.replace(/[£$€,\s]/g, '');
  if (cleaned === '' || !/^[+-]?\d*\.?\d+$/.test(cleaned)) return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (forcedSign === -1) return -Math.abs(n);
  if (forcedSign === 1) return Math.abs(n);
  return n;
}

// Normalise a date to ISO 'YYYY-MM-DD'. UK order (d/m/y) is assumed — this is a UK-only tool — and
// month/day ranges are validated. An unrecognised or out-of-range date returns null (the caller
// warns and keeps the row) rather than emitting a garbage ISO string that would silently mis-file.
export function normaliseDate(s) {
  if (!s) return null;
  const str = String(s).trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (iso) return validYMD(+iso[1], +iso[2], +iso[3]) ? iso3(+iso[1], +iso[2], +iso[3]) : null;

  const uk = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(str);
  if (uk) { const d = +uk[1], m = +uk[2], y = +uk[3]; return validYMD(y, m, d) ? iso3(y, m, d) : null; }

  const ukShort = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2})$/.exec(str);
  if (ukShort) { const d = +ukShort[1], m = +ukShort[2], y = pivotYear(+ukShort[3]); return validYMD(y, m, d) ? iso3(y, m, d) : null; }

  return null;
}

function validYMD(y, m, d) { return y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31; }
function iso3(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function pivotYear(yy) { return yy <= 69 ? 2000 + yy : 1900 + yy; }

// RFC-4180 record parser: quotes may span physical newlines, "" is an escaped quote. Returns an
// array of field-arrays. This replaces the old split-on-newline approach that tore quoted fields
// containing embedded newlines across two mangled rows.
function parseRecords(text) {
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let field = '', record = [], inQuotes = false, started = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') { inQuotes = true; started = true; }
    else if (ch === ',') { record.push(field); field = ''; started = true; }
    else if (ch === '\n') { record.push(field); records.push(record); record = []; field = ''; started = false; }
    else { field += ch; started = true; }
  }
  if (started || field !== '' || record.length) { record.push(field); records.push(record); }
  return records;
}

export function parseCSV(text) {
  const records = parseRecords(text).filter(r => r.some(c => c.trim() !== ''));
  if (records.length === 0) return { headers: [], rows: [] };

  const headerIdx = pickHeaderRow(records);
  const headers = records[headerIdx].map(h => h.trim());
  const rows = [];
  for (let i = headerIdx + 1; i < records.length; i++) {
    const values = records[i];
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (values[j] || '').trim();
    rows.push(row);
  }
  return { headers, rows };
}

// The header is the first row (within the first 15) that has both the most columns and a header-like
// keyword. A metadata banner above the table (statement title, account/sort-code rows) has fewer
// columns and no such keyword, so it is skipped rather than mistaken for the header.
function pickHeaderRow(records) {
  const HINT = /date|amount|description|details|memo|reference|balance|debit|credit|payee|counter|category/i;
  const limit = Math.min(records.length, 15);
  let best = 0, bestScore = -1;
  for (let i = 0; i < limit; i++) {
    const cols = records[i].filter(c => c.trim() !== '').length;
    const score = cols + (records[i].some(c => HINT.test(c)) ? 100 : 0);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

export function detectFormat(headers) {
  const hSet = headers.join(',');
  for (const fmt of KNOWN_FORMATS) if (fmt.detect(hSet)) return fmt;
  return null;
}

function genericMap(headers, row) {
  const dateKey = headers.find(h => /date/i.test(h));
  // Pick the amount column, but never a date column (e.g. 'Value Date' matches /value/ yet is a date).
  const amountKey =
    headers.find(h => /^amount$/i.test(h)) ||
    headers.find(h => /(amount|value|sum|paid|debit|credit)/i.test(h) && !/date/i.test(h)) ||
    headers.find(h => /(amount|value|sum)/i.test(h) && h !== dateKey);
  const descKey = headers.find(h => /desc|memo|narrat|detail|reference|name|party|payee/i.test(h) && h !== dateKey && h !== amountKey);

  const fallbackDesc = Object.entries(row)
    .filter(([k]) => k !== dateKey && k !== amountKey)
    .map(([, v]) => v)
    .find(v => v && typeof v === 'string' && v.length > 2) || '';

  return {
    date: (dateKey && row[dateKey]) || null,
    amount: parseAmount(amountKey ? row[amountKey] : null),
    description: (descKey && row[descKey]) || fallbackDesc,
    category: null,
    currency: 'GBP',
    reference: null,
    raw: row,
  };
}

export function ingest(csvText) {
  const { headers, rows } = parseCSV(csvText);
  if (rows.length === 0) return { format: null, transactions: [], errors: [], warnings: [], summary: summarise([]) };

  const fmt = detectFormat(headers);
  const mapper = fmt ? fmt.map : row => genericMap(headers, row);
  const transactions = [], errors = [], warnings = [];

  for (let i = 0; i < rows.length; i++) {
    let tx;
    try { tx = mapper(rows[i]); }
    catch (e) { errors.push({ row: i + 2, message: e.message }); continue; }

    if (tx.amount === null || tx.amount === undefined) {
      errors.push({ row: i + 2, message: 'could not parse amount', description: tx.description || null });
      continue;
    }
    tx.date = normaliseDate(tx.date);
    if (!tx.date) warnings.push({ row: i + 2, message: 'no recognisable date — excluded from period VAT returns', description: tx.description || null });

    transactions.push(tx);
  }

  return { format: fmt ? fmt.name : 'generic', transactions, errors, warnings, summary: summarise(transactions) };
}

function summarise(txs) {
  const dated = txs.map(t => t.date).filter(Boolean).sort();
  return {
    count: txs.length,
    income: txs.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0),
    expense: txs.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0),
    dateRange: dated.length ? [dated[0], dated[dated.length - 1]] : null,
  };
}

export async function ingestToVault(vault, csvText, batchId) {
  const result = ingest(csvText);
  const id = batchId || `batch-${Date.now()}-${_batchSeq++}`;

  // Never silently overwrite an existing batch — a reused id is a caller error, not a merge.
  const existing = await vault.keys();
  if (existing.includes(`manifest-${id}`)) throw new Error(`batch "${id}" already exists — choose a unique batch id`);

  for (let i = 0; i < result.transactions.length; i++) {
    const tx = result.transactions[i];
    const key = `tx-${id}-${String(i).padStart(5, '0')}`;
    await vault.put(key, { ...tx, raw: undefined, _batch: id });
  }

  const manifest = {
    id,
    format: result.format,
    count: result.transactions.length,
    summary: result.summary,
    errors: result.errors,
    warnings: result.warnings,
    ingestedAt: new Date().toISOString(),
  };
  await vault.put(`manifest-${id}`, manifest);
  return manifest;
}

export { KNOWN_FORMATS };
