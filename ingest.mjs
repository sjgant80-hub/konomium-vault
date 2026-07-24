// konomium-vault · ingest.mjs — the mouth (d=1)
// Parses CSV bank statements into normalised transaction records, ready for the vault.
// Handles common UK bank CSV formats (Monzo, Starling, HSBC, Barclays, generic).
// Zero dependencies. No network. The data never leaves the machine.

const REQUIRED_FIELDS = ['date', 'amount', 'description'];

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
        amount = inAmt !== 0 ? inAmt : -Math.abs(outAmt);
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

function parseAmount(s) {
  if (s == null) return 0;
  if (typeof s === 'number') return s;
  const cleaned = String(s).replace(/[£$€,\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function normaliseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const uk = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(str);
  if (uk) return `${uk[3]}-${uk[2].padStart(2, '0')}-${uk[1].padStart(2, '0')}`;
  const ukShort = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2})$/.exec(str);
  if (ukShort) return `20${ukShort[3]}-${ukShort[2].padStart(2, '0')}-${ukShort[1].padStart(2, '0')}`;
  return str;
}

export function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };

  let headerIdx = 0;
  while (headerIdx < lines.length && lines[headerIdx].trim() === '') headerIdx++;
  if (headerIdx >= lines.length) return { headers: [], rows: [] };

  const headers = splitCSVLine(lines[headerIdx]);
  const rows = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCSVLine(line);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] || '').trim();
    }
    rows.push(row);
  }

  return { headers, rows };
}

function splitCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function detectFormat(headers) {
  const hSet = headers.join(',');
  for (const fmt of KNOWN_FORMATS) {
    if (fmt.detect(hSet)) return fmt;
  }
  return null;
}

function genericMap(headers, row) {
  const dateKey = headers.find(h => /date/i.test(h));
  const amountKey = headers.find(h => /amount|value|sum/i.test(h));
  const descKey = headers.find(h => /desc|memo|narrat|detail|reference|name|party/i.test(h));
  return {
    date: row[dateKey] || null,
    amount: parseAmount(row[amountKey]),
    description: row[descKey] || Object.values(row).find(v => v && typeof v === 'string' && v.length > 3) || '',
    category: null,
    currency: 'GBP',
    reference: null,
    raw: row,
  };
}

export function ingest(csvText) {
  const { headers, rows } = parseCSV(csvText);
  if (rows.length === 0) return { format: null, transactions: [], errors: [] };

  const fmt = detectFormat(headers);
  const mapper = fmt ? fmt.map : row => genericMap(headers, row);
  const transactions = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    try {
      const tx = mapper(rows[i]);
      tx.date = normaliseDate(tx.date);
      if (tx.date && tx.amount !== 0) {
        transactions.push(tx);
      } else if (tx.amount === 0 && tx.description) {
        transactions.push(tx);
      }
    } catch (e) {
      errors.push({ row: i + 2, message: e.message });
    }
  }

  return {
    format: fmt ? fmt.name : 'generic',
    transactions,
    errors,
    summary: {
      count: transactions.length,
      income: transactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0),
      expense: transactions.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0),
      dateRange: transactions.length > 0
        ? [transactions[0].date, transactions[transactions.length - 1].date]
        : null,
    },
  };
}

export async function ingestToVault(vault, csvText, batchId) {
  const result = ingest(csvText);
  const id = batchId || `batch-${Date.now()}`;

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
    ingestedAt: new Date().toISOString(),
  };
  await vault.put(`manifest-${id}`, manifest);

  return manifest;
}

export { parseAmount, normaliseDate, KNOWN_FORMATS };
