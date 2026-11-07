// Tests for engine/review.mjs. Run: npm test
// Sections: (A) Codex's original 11 cases, (B) Claude review cases, (C) DECISIONS.md items,
// (D) full starter dataset vs answer key, (E) real public data — Montgomery County, MD.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { reviewInvoices, parseMoney } from '../engine/review.mjs';
import { parseCSV } from '../lib/csv.js';

const fixture = () => ({
  companyId: 'DEMO', asOf: '2026-02-23',
  invoices: [{ id: 'AP-00019', vendorId: 'VEN-019', invoiceNumber: 'VEN-019-00019', currency: 'USD', amount: '25263.67' }],
  payments: [
    { id: 'PAY-00019-1', vendorId: 'VEN-019', invoiceId: 'AP-00019', currency: 'USD', date: '2026-02-22', amount: '12631.83' },
    { id: 'PAY-00019-2', vendorId: 'VEN-019', invoiceId: 'AP-00019', currency: 'USD', date: '2026-02-23', amount: '12631.84' },
  ],
});
const one = input => reviewInvoices(input).results[0];

// ---------- (A) Codex's original cases, unchanged expectations ----------
test('A1 source example reconciles to the cent', () => {
  const r = one(fixture());
  assert.equal(r.matchedPaymentTotal, '25263.67'); assert.equal(r.difference, '0.00'); assert.equal(r.status, 'Paid in full');
});
test('A2 edited example is overpaid by $250', () => {
  const x = fixture(); x.payments[1].amount = '12881.84';
  const r = one(x); assert.equal(r.difference, '250.00'); assert.equal(r.status, 'Overpaid');
});
test('A3 missing invoice reference holds the verdict', () => {
  const x = fixture(); delete x.payments[1].invoiceId;
  const o = reviewInvoices(x);
  assert.equal(o.issues[0].code, 'missing_reference'); assert.match(o.issues[0].nextStep, /remittance advice/);
  assert.equal(o.results[0].difference, null);
});
test('A4 re-importing the same rows leaves totals unchanged', () => {
  const x = fixture(); x.payments.push(...structuredClone(x.payments));
  const o = reviewInvoices(x); assert.equal(o.skippedDuplicates, 2); assert.equal(o.results[0].difference, '0.00');
});
test('A5 conflicting versions of a payment hold the verdict in either order', () => {
  const x = fixture(); x.payments.push({ ...x.payments[1], amount: '12881.84' });
  for (const payments of [x.payments, [...x.payments].reverse()]) {
    const o = reviewInvoices({ ...x, payments });
    assert.equal(o.issues[0].code, 'conflicting_payment'); assert.equal(o.results[0].difference, null);
  }
});
test('A6 different payment IDs with equal amounts both count', () => {
  const x = fixture(); x.payments[1].amount = '12631.83';
  const r = one(x); assert.equal(r.matchedPaymentTotal, '25263.66'); assert.equal(r.difference, '-0.01'); assert.equal(r.status, 'Remaining balance');
});
test('A7 one cent of overpayment remains visible', () => {
  const x = fixture(); x.payments[1].amount = '12631.85'; assert.equal(one(x).difference, '0.01');
});
test('A8 a payment after the cutoff is excluded', () => {
  const x = fixture(); x.asOf = '2026-02-22';
  const o = reviewInvoices(x); assert.deepEqual(o.excludedAfterCutoff, ['PAY-00019-2']); assert.equal(o.results[0].difference, '-12631.84');
});
test('A9 vendor mismatch prevents allocation', () => {
  const x = fixture(); x.payments[1].vendorId = 'OTHER';
  const o = reviewInvoices(x); assert.equal(o.results[0].status, 'Needs review'); assert.equal(o.issues[0].code, 'vendor_mismatch'); assert.match(o.issues[0].nextStep, /OTHER/);
});
test('A10 an unknown invoice produces a source lookup recommendation', () => {
  const x = fixture(); x.payments[1].invoiceId = 'AP-99999';
  const o = reviewInvoices(x); assert.equal(o.issues[0].code, 'unknown_invoice'); assert.match(o.issues[0].nextStep, /AP-99999/); assert.equal(o.results[0].difference, null);
});
test('A11 blank, non-numeric and over-precise amounts are rejected (never zero)', () => {
  for (const v of ['', undefined, 'abc', '0.001']) {
    const x = fixture(); x.payments[1].amount = v; assert.throws(() => reviewInvoices(x), /Payment row 2/);
  }
});

// ---------- (B) Claude review cases ----------
test('B1 trailing-space re-import is the same payment (was a false $12,631.84 overpayment)', () => {
  const x = fixture(); x.payments.push({ ...x.payments[1], id: 'PAY-00019-2 ' });
  const o = reviewInvoices(x); assert.equal(o.results[0].difference, '0.00'); assert.equal(o.skippedDuplicates, 1);
});
test('B2 different-case re-import is the same payment', () => {
  const x = fixture(); x.payments.push({ ...x.payments[1], id: 'pay-00019-2', vendorId: 'ven-019', invoiceId: 'ap-00019' });
  assert.equal(one(x).difference, '0.00');
});
test('B3 an unmatched payment from another vendor does not hold an unrelated invoice (O1)', () => {
  const x = fixture();
  x.invoices.push({ id: 'AP-2', vendorId: 'VEN-2', currency: 'USD', amount: '100.00' });
  x.payments.push({ id: 'P-X', vendorId: 'VEN-2', currency: 'USD', date: '2026-02-01', amount: '100.00' });
  const o = reviewInvoices(x);
  assert.equal(o.results.find(r => r.invoiceId === 'AP-00019').status, 'Paid in full');
  assert.equal(o.results.find(r => r.invoiceId === 'AP-2').status, 'Needs review');
  assert.deepEqual(o.issues[0].affects, ['AP-2']);
});
test('B4 the same vendor bill recorded twice and paid twice is flagged (L1)', () => {
  const x = fixture();
  x.invoices.push({ id: 'AP-00019B', vendorId: 'VEN-019', invoiceNumber: 'VEN-019-00019', currency: 'USD', amount: '25263.67' });
  x.payments.push({ id: 'PAY-B', vendorId: 'VEN-019', invoiceId: 'AP-00019B', currency: 'USD', date: '2026-02-23', amount: '25263.67' });
  const o = reviewInvoices(x);
  assert.ok(o.results.every(r => r.status === 'Possible duplicate bill'));
  const s = o.signals.find(s => s.code === 'possible_duplicate_bill');
  assert.equal(s.paidCopies, 2); assert.equal(s.excessIfOneBill, '25263.67');
});
test('B5 spreadsheet money formats are parsed exactly (O3)', () => {
  assert.equal(parseMoney('$12,631.83'), 1263183n);
  assert.equal(parseMoney('1234.5'), 123450n);
  assert.equal(parseMoney('(250.00)'), -25000n);
  assert.equal(parseMoney('-250'), -25000n);
  for (const bad of ['12,63.83', '$', '1.234', '1e3', '12 34']) assert.throws(() => parseMoney(bad));
});

// ---------- (C) DECISIONS.md items ----------
test('C1 D7: a payment dated exactly on the review date is included', () => {
  const x = fixture(); x.asOf = '2026-02-23'; assert.equal(one(x).difference, '0.00');
});
test('C2 O2: a vendor refund is netted but holds the invoice for review', () => {
  const x = fixture(); x.payments[1].amount = '12881.84';
  x.payments.push({ id: 'REF-1', vendorId: 'VEN-019', invoiceId: 'AP-00019', currency: 'USD', date: '2026-02-23', amount: '(250.00)' });
  const o = reviewInvoices(x); const r = o.results[0];
  assert.equal(r.matchedPaymentTotal, '25263.67'); assert.equal(r.status, 'Needs review'); assert.deepEqual(r.heldFor, ['refund_or_credit']);
  assert.match(o.issues[0].nextStep, /payment register/);
});
test('C3 D9: two payment IDs for the same amount on one invoice raise a duplicate-payment signal', () => {
  const x = fixture(); x.payments[1].amount = '12631.83';
  x.payments.push({ id: 'PAY-00019-3', vendorId: 'VEN-019', invoiceId: 'AP-00019', currency: 'USD', date: '2026-02-23', amount: '12631.83' });
  const s = reviewInvoices(x).signals.find(s => s.code === 'possible_duplicate_payment');
  assert.equal(s.amount, '12631.83'); assert.equal(s.paymentIds.length, 3);
});

test('C4 D9: equal split payments that add up to the bill raise no duplicate signal', () => {
  const x = fixture();
  x.invoices[0].amount = '100.00';
  x.payments[0].amount = '50.00'; x.payments[1].amount = '50.00';
  const o = reviewInvoices(x);
  assert.equal(o.results[0].status, 'Paid in full');
  assert.equal(o.signals.length, 0);
});

// ---------- (D) Full starter dataset vs answer key (answer key read only after computing) ----------
test('D1 starter data: 40/40 overpayments, 0 false flags, totals equal paid_usd, 15/15 duplicate bills', async () => {
  const load = async n => parseCSV(await fs.readFile(new URL(`../data/${n}.csv`, import.meta.url), 'utf8'));
  const inv = await load('invoices'), pay = await load('payments');
  const o = reviewInvoices({
    companyId: 'CO-001', asOf: '2026-09-30',
    invoices: inv.map(r => ({ id: r.record_id, vendorId: r.vendor_id, invoiceNumber: r.invoice_number, currency: r.currency, amount: r.amount_usd })),
    payments: pay.map(p => ({ id: p.record_id, vendorId: p.vendor_id, invoiceId: p.invoice_record_id, currency: p.currency, date: p.payment_date, amount: p.amount_usd })),
  });
  const key = JSON.parse(await fs.readFile(new URL('../validation/ap-answer-key.json', import.meta.url), 'utf8'));
  const want = rule => new Set(key.findings.filter(f => f.rule === rule).map(f => f.record_id));
  const over = new Set(o.results.filter(r => r.status === 'Overpaid').map(r => r.invoiceId));
  assert.deepEqual([...over].sort(), [...want('overpayment')].sort());
  assert.equal(o.issues.length, 0);
  const paid = new Map(inv.map(r => [r.record_id, r.paid_usd]));
  assert.ok(o.results.every(r => r.matchedPaymentTotal === paid.get(r.invoiceId)));
  // Every answer-key duplicate (the later copy) is now flagged, together with its original.
  const dupFlagged = new Set(o.results.filter(r => r.status === 'Possible duplicate bill').map(r => r.invoiceId));
  for (const id of want('duplicate_invoice')) assert.ok(dupFlagged.has(id), id);
  assert.equal(o.signals.filter(s => s.code === 'possible_duplicate_bill').length, 15);
});

// ---------- (E) Real public data: Montgomery County, MD (data/real/) ----------
test('E1 Bound Tree Medical invoice 85957920 line 1: paid twice, flagged as possible duplicate payment', async () => {
  const rows = parseCSV(await fs.readFile(new URL('../data/real/montgomery-bound-tree-85957920.csv', import.meta.url), 'utf8'));
  // Public ledger has no billed amount. Stated assumption: the invoice line's amount equals one payment row.
  const o = reviewInvoices({
    companyId: 'MONTGOMERY-COUNTY-MD', asOf: '2025-10-31',
    invoices: [{ id: '85957920-L1', vendorId: '15993', invoiceNumber: '85957920', currency: 'USD', amount: rows[0].amount_usd }],
    payments: rows.map(r => ({ id: r.payment_id, vendorId: r.vendor_id, invoiceId: '85957920-L1', currency: 'USD', date: r.payment_date, amount: r.amount_usd })),
  });
  const r = o.results[0];
  assert.equal(r.matchedPaymentTotal, '424.84'); assert.equal(r.difference, '212.42'); assert.equal(r.status, 'Overpaid');
  const s = o.signals.find(s => s.code === 'possible_duplicate_payment');
  assert.deepEqual(s.paymentIds, ['844069', '844239']);
});
