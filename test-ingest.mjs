#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, detectFormat, ingest, ingestToVault, parseAmount, normaliseDate } from './ingest.mjs';
import { Vault } from './vault.mjs';

const SEED = 'correct horse battery staple';

const MONZO_CSV = `Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In
tx_0001,15/03/2026,14:30:00,Card,Tesco,,Groceries,-45.67,GBP,-45.67,GBP,weekly shop,,,,,-45.67,
tx_0002,16/03/2026,09:15:00,Faster Payment,ACME Corp,,Income,2500.00,GBP,2500.00,GBP,invoice payment,,,,,, 2500.00`;

const STARLING_CSV = `Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category
15/03/2026,Sainsburys,CARD PAYMENT,CARD,-32.10,1500.00,GROCERIES
16/03/2026,Client Ltd,INVOICE 42,FASTER_PAYMENT,1200.00,2700.00,INCOME`;

const HSBC_CSV = `Transaction Date,Transaction Description,Transaction Amount
15/03/2026,DIRECT DEBIT VODAFONE,-29.00
16/03/2026,SALARY,3200.00`;

const BARCLAYS_MONEY_CSV = `Date,Description,Memo,Money out,Money in
15/03/2026,DIRECT DEBIT,VODAFONE LTD,29.00,
16/03/2026,BANK GIRO CREDIT,SALARY,,3200.00`;

const BARCLAYS_PLAIN_CSV = `Date,Memo,Amount
15/03/2026,VODAFONE LTD,-29.00
16/03/2026,SALARY,3200.00`;

const GENERIC_CSV = `Date,Details,Amount
2026-03-15,Coffee Shop,-4.50
2026-03-16,Freelance Payment,800.00`;

test('parseCSV splits headers and rows', () => {
  const { headers, rows } = parseCSV(GENERIC_CSV);
  assert.deepEqual(headers, ['Date', 'Details', 'Amount']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['Amount'], '-4.50');
});

test('parseCSV handles quoted fields with commas', () => {
  const { rows } = parseCSV('Name,Amount\n"Smith, John",100.00');
  assert.equal(rows[0]['Name'], 'Smith, John');
});

test('parseCSV handles a quoted field containing an embedded newline (RFC-4180)', () => {
  const csv = 'Date,Details,Amount\n2026-03-15,"Line one\nLine two",-4.50';
  const { rows } = parseCSV(csv);
  assert.equal(rows.length, 1, 'the embedded newline does not split the row');
  assert.equal(rows[0]['Details'], 'Line one\nLine two');
  assert.equal(rows[0]['Amount'], '-4.50');
});

test('parseCSV handles escaped double-quotes ("")', () => {
  const { rows } = parseCSV('Name,Amount\n"a ""quoted"" name",5');
  assert.equal(rows[0]['Name'], 'a "quoted" name');
});

test('parseCSV skips a non-blank metadata preamble and finds the real header', () => {
  const csv = `Account Statement\nAccount: 12345678  Sort code: 12-34-56\nDate,Details,Amount\n2026-03-15,Coffee,-4.50\n2026-03-16,Salary,2000.00`;
  const { headers, rows } = parseCSV(csv);
  assert.deepEqual(headers, ['Date', 'Details', 'Amount']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['Details'], 'Coffee');
});

test('parseCSV handles empty input', () => {
  assert.equal(parseCSV('').rows.length, 0);
});

test('detectFormat identifies Monzo, Starling, HSBC, Barclays', () => {
  assert.equal(detectFormat(parseCSV(MONZO_CSV).headers).name, 'monzo');
  assert.equal(detectFormat(parseCSV(STARLING_CSV).headers).name, 'starling');
  assert.equal(detectFormat(parseCSV(HSBC_CSV).headers).name, 'hsbc');
  assert.equal(detectFormat(parseCSV(BARCLAYS_MONEY_CSV).headers).name, 'barclays');
});

test('detectFormat returns null for unknown formats', () => {
  assert.equal(detectFormat(['Foo', 'Bar', 'Baz']), null);
});

test('parseAmount handles currency symbols, commas, and spaces', () => {
  assert.equal(parseAmount('£1,234.56'), 1234.56);
  assert.equal(parseAmount('$-50.00'), -50);
  assert.equal(parseAmount('€ 99.99'), 99.99);
  assert.equal(parseAmount(42), 42);
});

test('parseAmount handles accountancy negatives, DR/CR suffixes, and trailing minus', () => {
  assert.equal(parseAmount('(50.00)'), -50);
  assert.equal(parseAmount('50.00 DR'), -50);
  assert.equal(parseAmount('50.00 CR'), 50);
  assert.equal(parseAmount('100.00-'), -100);
  assert.equal(parseAmount('(£1,200.00)'), -1200);
});

test('parseAmount returns null (not 0) for genuinely unparseable input', () => {
  assert.equal(parseAmount('not a number'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount('   '), null);
});

test('normaliseDate handles ISO, UK dd/mm/yyyy, and UK short dd/mm/yy with a pivot', () => {
  assert.equal(normaliseDate('2026-03-15'), '2026-03-15');
  assert.equal(normaliseDate('15/03/2026'), '2026-03-15');
  assert.equal(normaliseDate('1/3/2026'), '2026-03-01');
  assert.equal(normaliseDate('15/03/26'), '2026-03-15');
  assert.equal(normaliseDate('15/03/95'), '1995-03-15', 'pivot: 95 -> 1995');
});

test('normaliseDate returns null for out-of-range/invalid dates (never a garbage ISO string)', () => {
  assert.equal(normaliseDate('12/31/2025'), null, 'US-order month 31 is rejected, not emitted as 2025-31-12');
  assert.equal(normaliseDate('13/13/2025'), null);
  assert.equal(normaliseDate('15 Jan 2026'), null, 'textual month unrecognised -> null');
  assert.equal(normaliseDate(null), null);
});

test('ingest parses each bank format', () => {
  assert.equal(ingest(MONZO_CSV).format, 'monzo');
  assert.equal(ingest(STARLING_CSV).format, 'starling');
  assert.equal(ingest(HSBC_CSV).format, 'hsbc');
  assert.equal(ingest(BARCLAYS_MONEY_CSV).format, 'barclays');
});

test('ingest HSBC: correct amounts and count', () => {
  const r = ingest(HSBC_CSV);
  assert.equal(r.transactions.length, 2);
  assert.equal(r.transactions[0].amount, -29);
  assert.equal(r.transactions[1].amount, 3200);
});

test('ingest Barclays plain-Amount variant (no Money in/out columns)', () => {
  const r = ingest(BARCLAYS_PLAIN_CSV);
  assert.equal(r.format, 'barclays');
  assert.equal(r.transactions[0].amount, -29);
  assert.equal(r.transactions[1].amount, 3200);
});

test('ingest Barclays Money in/out: signs are correct', () => {
  const r = ingest(BARCLAYS_MONEY_CSV);
  assert.ok(r.transactions[0].amount < 0, 'money out is negative');
  assert.ok(r.transactions[1].amount > 0, 'money in is positive');
});

test('ingest generic fallback with an unknown header set', () => {
  const r = ingest(GENERIC_CSV);
  assert.equal(r.format, 'generic');
  assert.equal(r.transactions.length, 2);
  assert.equal(r.transactions[0].amount, -4.5);
});

test('generic amount-column detection ignores a date column named "Value Date"', () => {
  const csv = `Value Date,Amount,Balance\n2026-03-15,-4.50,100.00\n2026-03-16,-9.99,90.01`;
  const r = ingest(csv);
  assert.equal(r.transactions[0].amount, -4.5, 'the real Amount column is used, not "Value Date"');
  assert.equal(r.transactions[1].amount, -9.99);
});

test('ingest records an ERROR (never a silent £0) for an unreadable amount', () => {
  const csv = `Date,Details,Amount\n2026-03-15,Supplier Invoice,not-a-number\n2026-03-16,Client,600.00`;
  const r = ingest(csv);
  assert.equal(r.transactions.length, 1, 'the unreadable row is not stored as a transaction');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /amount/);
});

test('ingest KEEPS a row with a valid amount but no date, and WARNS (never silently dropped)', () => {
  const csv = `When,Details,Amount\n2026-03-15,Coffee,-4.50\n2026-03-16,Pay,800.00`;
  const r = ingest(csv);
  assert.equal(r.transactions.length, 2, 'both valid-amount rows are retained');
  assert.equal(r.warnings.length, 2, 'both are flagged as dateless');
  assert.equal(r.transactions[0].date, null);
});

test('ingest summary.dateRange uses min/max even when rows are newest-first', () => {
  const csv = `Date,Details,Amount\n16/03/2026,Newer,-1.00\n15/03/2026,Older,-2.00`;
  const r = ingest(csv);
  assert.deepEqual(r.summary.dateRange, ['2026-03-15', '2026-03-16']);
});

test('ingestToVault encrypts transactions and stores a manifest with errors/warnings', async () => {
  const v = await new Vault().open(SEED);
  const manifest = await ingestToVault(v, MONZO_CSV, 'test-batch');
  assert.equal(manifest.count, 2);
  assert.equal(manifest.format, 'monzo');
  assert.ok(Array.isArray(manifest.errors) && Array.isArray(manifest.warnings));

  const tx0 = await v.get('tx-test-batch-00000');
  assert.equal(tx0.amount, -45.67);
  assert.equal(tx0.raw, undefined, 'raw row data is NOT stored in the vault');
});

test('ingestToVault refuses to silently overwrite an existing batch id', async () => {
  const v = await new Vault().open(SEED);
  await ingestToVault(v, GENERIC_CSV, 'dup');
  await assert.rejects(() => ingestToVault(v, GENERIC_CSV, 'dup'), /already exists/);
});

test('ingestToVault data is encrypted at rest', async () => {
  const { memoryAdapter } = await import('./vault.mjs');
  const adapter = memoryAdapter();
  const v = await new Vault({ adapter }).open(SEED);
  await ingestToVault(v, MONZO_CSV, 'enc-test');
  const stored = JSON.stringify(await adapter.get('tx-enc-test-00000'));
  assert.ok(!stored.includes('Tesco'));
  assert.ok(!stored.includes('45.67'));
});


// ─── the boundaries the mutation gate proved nothing was holding (estate bring-up) ───

test('THE DATE WINDOW IS INCLUSIVE AT ALL SIX EDGES — 1900-01-01 and 2200-12-31 are real dates', () => {
  // y>=1900, y<=2200, m>=1, m<=12, d>=1, d<=31: each flipped boundary silently voids a real date —
  // every 1st of January, every 31st, the whole first and last supported year.
  assert.equal(normaliseDate('1900-01-01'), '1900-01-01');
  assert.equal(normaliseDate('2200-12-31'), '2200-12-31');
  assert.equal(normaliseDate('1899-06-15'), null);
  assert.equal(normaliseDate('2201-06-15'), null);
});

test('THE TWO-DIGIT PIVOT IS 69/70 — the standard UNIX pivot, exactly', () => {
  assert.equal(normaliseDate('15/03/69'), '2069-03-15', 'yy=69 must pivot forward');
  assert.equal(normaliseDate('15/03/70'), '1970-03-15', 'yy=70 must pivot back');
});

test('SCIENTIFIC NOTATION IS NOT A BANK AMOUNT — the regex is the guard, not Number()', () => {
  // `cleaned === '' || !regex` flipped to && short-circuits past the regex for any non-empty
  // string, and Number('1e5') is a perfectly finite 100000 — an amount invented from a typo.
  assert.strictEqual(parseAmount('1e5'), null, 'scientific notation was accepted as money');
  assert.strictEqual(parseAmount('0x10'), null, 'hex was accepted as money');
});

test('A FORMAT NEEDS *BOTH* ITS SIGNATURE COLUMNS — one alone is not a detection', () => {
  // Each detect() is an AND of two signatures. Flipped to OR, a generic CSV that merely mentions
  // "Counter Party" gets Starling column mappings applied to columns that do not exist.
  assert.strictEqual(detectFormat(['Date', 'Counter Party', 'Amount']), null,
    'Counter Party without Amount (GBP) must not read as Starling');
  assert.strictEqual(detectFormat(['Transaction Date', 'Amount']), null,
    'Transaction Date without Transaction Description must not read as HSBC');
  assert.equal(detectFormat(['Date', 'Memo', 'Amount']).name, 'barclays',
    'Memo + Amount is a real Barclays signature — the OR arm must stay an OR');
});

test('MONZO FIELDS LAND EXACTLY — every || fallback keeps the primary when it is present', () => {
  // date/description/category/currency/reference each read `primary || fallback`. Flipped to &&,
  // a populated primary hands back the FALLBACK: descriptions become the counterparty short-name,
  // EUR becomes GBP, references vanish.
  const csv = 'Transaction ID,Date,Amount,Description,Category,Currency,Name\n' +
    'tx_1,01/02/2026,-4.50,COSTA COFFEE,Eating out,EUR,Costa';
  const r = ingest(csv);
  assert.equal(r.format, 'monzo');
  const tx = r.transactions[0];
  assert.equal(tx.date, '2026-02-01', 'the Date column was ignored for a missing Created');
  assert.equal(tx.description, 'COSTA COFFEE');
  assert.equal(tx.category, 'Eating out');
  assert.equal(tx.currency, 'EUR', 'a real currency was overwritten with the GBP default');
  assert.equal(tx.reference, 'tx_1');
});

test('STARLING FIELDS LAND EXACTLY — counterparty, category and reference survive their fallbacks', () => {
  const csv = 'Date,Counter Party,Amount (GBP),Spending Category,Reference\n' +
    '01/02/2026,ACME LTD,-12.50,Travel,REF9';
  const r = ingest(csv);
  assert.equal(r.format, 'starling');
  const tx = r.transactions[0];
  assert.equal(tx.description, 'ACME LTD', 'the counterparty fell through to the reference');
  assert.equal(tx.category, 'Travel');
  assert.equal(tx.reference, 'REF9');
});

test('BARCLAYS DESCRIPTION CHAIN — a filled Memo wins, an empty Memo falls to Subcategory', () => {
  const csv = 'Date,Memo,Amount,Subcategory\n' +
    '01/02/2026,TESCO STORES,-20.00,Food\n' +
    '02/02/2026,,-5.00,Snacks';
  const r = ingest(csv);
  assert.equal(r.format, 'barclays');
  assert.equal(r.transactions[0].description, 'TESCO STORES', 'a filled Memo was skipped');
  assert.equal(r.transactions[0].category, 'Food');
  assert.equal(r.transactions[1].description, 'Snacks', 'an empty Memo did not fall through');
});

test('MONEY IN/OUT SPLIT NEEDS BOTH COLUMNS — Money in alone must not be trusted as the amount', () => {
  // `'Money in' in row && 'Money out' in row` flipped to || reads a lone Money-in column as the
  // signed amount with no outflow column to balance it. The contract: both columns or use Amount —
  // and with no Amount column either, the row is an ERROR, never a silent guess.
  const csv = 'Date,Memo,Money in\n01/02/2026,coffee,50';
  const r = ingest(csv);
  assert.equal(r.format, 'barclays');
  assert.equal(r.transactions.length, 0);
  assert.equal(r.errors.length, 1, 'a half-split row was silently given an amount');
});

test('GENERIC AMOUNT PICKING NEVER SEATS A DATE COLUMN — and the last-resort arm is exact', () => {
  // 'Value Date' matches /value/ but is a date; only `&& !/date/` keeps it out of the amount seat.
  const r1 = ingest('Value Date,Paid Out,Details\n01/02/2026,12.50,card payment');
  assert.equal(r1.format, 'generic');
  assert.equal(r1.transactions[0].amount, 12.5, 'the amount was read from the date column');

  // Last-resort arm: every amount-ish header also says date, except one — and the non-amount
  // column ahead of it must not be seated by a flipped && either.
  const r2 = ingest('Date,Notes,Sum date\n01/02/2026,coffee shop,42.00');
  assert.equal(r2.transactions[0].amount, 42, 'the h !== dateKey arm picked the wrong column');
  assert.equal(r2.transactions[0].description, 'coffee shop');
});

test('THE DESC SEAT REFUSES THE DATE AND AMOUNT COLUMNS EVEN WHEN THEY MATCH ITS OWN REGEX', () => {
  // 'Reference Date' matches /reference/ AND is the date column; 'Reference Value' matches AND is
  // the amount column. Only the !== guards keep the description from becoming a date or a number.
  const r1 = ingest('Reference Date,Amount,Payee Name\n01/02/2026,-9.99,ACME LTD');
  assert.equal(r1.transactions[0].description, 'ACME LTD', 'the desc seat took the date column');

  const r2 = ingest('Date,Reference Value,Payee Name\n01/02/2026,-9.99,ACME LTD');
  assert.equal(r2.transactions[0].amount, -9.99);
  assert.equal(r2.transactions[0].description, 'ACME LTD', 'the desc seat took the amount column');

  // and a non-matching column ahead of the real one must not be seated by a flipped &&
  const r3 = ingest('Date,Amount,Category,Payee Name\n01/02/2026,-9.99,Groceries,ACME LTD');
  assert.equal(r3.transactions[0].description, 'ACME LTD', 'a non-desc column was seated');
});

test('THE FALLBACK DESCRIPTION SKIPS DATE, AMOUNT, EMPTIES AND TWO-CHAR CODES', () => {
  // No desc-regex header at all → fallback walks the row values. It must skip the date value, the
  // amount value, empty strings, and anything ≤2 chars — each skip is one mutant.
  const r = ingest('Date,Amount,Void,Code,Info\n01/02/2026,-9.99,,ab,coffee shop');
  assert.equal(r.transactions[0].description, 'coffee shop',
    'the fallback description picked a date, an amount, an empty cell or a 2-char code');
});

test('A ROW CARRIES EXACTLY ITS HEADERS — no phantom keys from a loop overrun', () => {
  // `j < headers.length` flipped to <= writes row[undefined] = '' into every row. The tx keeps the
  // raw row verbatim, so the phantom key is visible — and would be stored in the vault forever.
  const r = ingest('Date,Amount,Info\n01/02/2026,-9.99,coffee shop');
  assert.deepEqual(r.transactions[0].raw, { Date: '01/02/2026', Amount: '-9.99', Info: 'coffee shop' });
});

// ── 2026-08-27 gate-hardening: three survivors pinned dead ──

test('an amount-error row carries its description VERBATIM, and null only when truly absent', () => {
  const r = ingest('Date,Amount,Info\n01/02/2026,not-a-number,coffee shop');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].description, 'coffee shop', 'the description rides through, never nulled by the fallback');
  const bare = ingest('Date,Amount\n01/02/2026,not-a-number');
  assert.equal(bare.errors[0].description, null, 'absent description reads null exactly, not undefined');
});

test('a dateless row warns with its description VERBATIM', () => {
  const r = ingest('Date,Amount,Info\nnot-a-date,-5.00,bus fare');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].description, 'bus fare');
});

test('ingestToVault stores EXACTLY count transactions — never a phantom extra key', async () => {
  const v = await new Vault().open(SEED);
  const manifest = await ingestToVault(v, MONZO_CSV, 'exact-count');
  const txKeys = (await v.keys()).filter((k) => k.startsWith('tx-exact-count-'));
  assert.equal(txKeys.length, manifest.count, 'one key per transaction, no off-by-one phantom');
});
