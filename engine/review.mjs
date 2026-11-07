// Invoice overpayment review engine — RedHawk Builds 2026, Challenge #10.
//
// Same entry point and output shape as the Codex prototype (reviewInvoices), with these changes,
// each tied to an entry in DECISIONS.md:
//   D4+  IDs are compared trimmed and upper-cased, so "PAY-1 " and "pay-1" are the same payment.
//   O1   An unclear payment holds only the invoices it could belong to, not the whole batch.
//   O2   Refunds/credits (negative amounts) are accepted, netted, and hold the invoice for review.
//   O3   Amounts like "$1,234.50", "1234.5" and "(250.00)" are parsed; >2 decimals is an error.
//   D7   A payment dated ON the review date is included.
//   L1   Same vendor + same printed invoice number on two invoice records = possible duplicate bill.
//   D9   Two different payment IDs, same vendor, same invoice, same amount = possible duplicate payment.
// All arithmetic is integer cents via the starter's lib/finance.js.
import { minor, amount, dateDays } from '../lib/finance.js';

const key = v => String(v).trim().toUpperCase();

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must not be blank`);
  return value.trim();
}

// O3: accept common spreadsheet money formats, reject anything ambiguous. Returns signed cents.
export function parseMoney(value, label = 'Amount') {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is blank`);
  let text = value.trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1).trim(); }
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1).trim(); }
  text = text.replace(/^\$/, '').trim();
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(text)) {
    throw new Error(`${label} "${value}" is not a dollar amount. Use a format like 1234.50`);
  }
  text = text.replace(/,/g, '');
  if ((text.split('.')[1] || '').length > 2) {
    throw new Error(`${label} "${value}" has more than 2 decimal places; it will not be rounded`);
  }
  const cents = minor(text);
  return negative ? -cents : cents;
}

const NEXT_STEP = {
  missing_reference: () => 'Find the invoice allocation in the remittance advice or payment register. Enter the confirmed invoice ID. If the payment covers several invoices, get the breakdown first.',
  unknown_invoice: p => `Locate invoice ${p.invoiceId} in the source records. Confirm it belongs to this company and vendor, then add it or correct the reference.`,
  vendor_mismatch: (p, inv) => `Check the vendor master and remittance advice: the payment names ${p.vendorId}, the invoice names ${inv.vendorId}. Confirm which is right before editing either record.`,
  conflicting_payment: () => 'Compare every version of this payment ID against the payment register. Confirm amount, date, vendor and invoice, correct the wrong record, and run the check again.',
  refund_or_credit: () => 'Confirm the refund or credit in the payment register and bank statement before treating it as offsetting this invoice.',
};

/**
 * @param {object} input
 * @param {string} input.companyId
 * @param {string} input.asOf  review-through date, YYYY-MM-DD (inclusive)
 * @param {Array<{id,vendorId,amount,currency,invoiceNumber?}>} input.invoices
 * @param {Array<{id,vendorId,invoiceId?,amount,currency,date}>} input.payments
 */
export function reviewInvoices({ companyId, asOf, invoices, payments }) {
  required(companyId, 'Company ID');
  const cutoff = dateDays(asOf);
  if (!Array.isArray(invoices) || !Array.isArray(payments)) throw new Error('Invoices and payments must be lists');

  // ---- Invoices -----------------------------------------------------------------------------
  const invoiceMap = new Map();   // key(id) -> invoice record
  const byVendor = new Map();     // key(vendorId) -> [key(invoice id)]
  invoices.forEach((inv, i) => {
    const row = `Invoice row ${i + 1}`;
    const id = required(inv.id, `${row}: invoice ID`);
    const vendorId = required(inv.vendorId, `${row}: vendor ID`);
    if ((inv.currency ?? 'USD') !== 'USD') throw new Error(`${row}: only USD is supported`);
    const cents = parseMoney(inv.amount, `${row}: amount`);
    if (cents < 0n) throw new Error(`${row}: invoice amount cannot be negative`);
    if (invoiceMap.has(key(id))) throw new Error(`${row}: invoice ID ${id} appears twice`);
    invoiceMap.set(key(id), { id, vendorId, cents, invoiceNumber: inv.invoiceNumber?.trim() || null });
    if (!byVendor.has(key(vendorId))) byVendor.set(key(vendorId), []);
    byVendor.get(key(vendorId)).push(key(id));
  });

  // ---- Payments: dedupe by normalized ID, detect conflicts (D4) -----------------------------
  const unique = new Map();       // key(payment id) -> {payment, cents, versions:[]}
  let skippedDuplicates = 0;
  payments.forEach((p, i) => {
    const row = `Payment row ${i + 1}`;
    const id = required(p.id, `${row}: payment ID`);
    const vendorId = required(p.vendorId, `${row}: vendor ID`);
    if ((p.currency ?? 'USD') !== 'USD') throw new Error(`${row}: only USD is supported`);
    const cents = parseMoney(p.amount, `${row}: amount`);
    try { dateDays(p.date); } catch { throw new Error(`${row}: date "${p.date}" must be YYYY-MM-DD`); }
    if (p.invoiceId != null && typeof p.invoiceId !== 'string') throw new Error(`${row}: invoice reference must be text`);
    const invoiceId = p.invoiceId?.trim() || null;
    const clean = { ...p, id, vendorId, invoiceId };
    const signature = JSON.stringify([key(vendorId), invoiceId && key(invoiceId), cents.toString(), p.date]);
    const prev = unique.get(key(id));
    if (!prev) unique.set(key(id), { payment: clean, cents, signature, versions: [clean] });
    else if (prev.signature === signature) skippedDuplicates += 1;
    else { prev.conflict = true; prev.versions.push(clean); }
  });

  // ---- Allocate ------------------------------------------------------------------------------
  const totals = new Map([...invoiceMap.keys()].map(k => [k, 0n]));
  const evidence = new Map([...invoiceMap.keys()].map(k => [k, []]));
  const holds = new Map([...invoiceMap.keys()].map(k => [k, new Set()]));
  const issues = [];
  const excludedAfterCutoff = [];
  const hold = (keys, issue) => {
    const affected = [...new Set(keys)].filter(k => invoiceMap.has(k));
    for (const k of affected) holds.get(k).add(issue.code);
    issues.push({ ...issue, affects: affected.map(k => invoiceMap.get(k).id) });
  };
  const vendorInvoices = vendorId => byVendor.get(key(vendorId)) || [];

  for (const { payment, cents, conflict, versions } of unique.values()) {
    if (conflict) {
      const keys = versions.flatMap(v => [...(v.invoiceId ? [key(v.invoiceId)] : []), ...vendorInvoices(v.vendorId)]);
      hold(keys, { paymentId: payment.id, reason: 'Conflicting payment records', code: 'conflicting_payment', nextStep: NEXT_STEP.conflicting_payment() });
      continue;
    }
    if (dateDays(payment.date) > cutoff) { excludedAfterCutoff.push(payment.id); continue; }   // D7: on-date included
    if (!payment.invoiceId) {
      hold(vendorInvoices(payment.vendorId), { paymentId: payment.id, reason: 'Needs matching', code: 'missing_reference', nextStep: NEXT_STEP.missing_reference(payment) });
      continue;
    }
    const k = key(payment.invoiceId);
    const invoice = invoiceMap.get(k);
    if (!invoice) {
      hold(vendorInvoices(payment.vendorId), { paymentId: payment.id, reason: 'Needs matching', code: 'unknown_invoice', nextStep: NEXT_STEP.unknown_invoice(payment) });
      continue;
    }
    if (key(invoice.vendorId) !== key(payment.vendorId)) {
      hold([k, ...vendorInvoices(payment.vendorId)], { paymentId: payment.id, reason: 'Needs matching', code: 'vendor_mismatch', nextStep: NEXT_STEP.vendor_mismatch(payment, invoice) });
      continue;
    }
    totals.set(k, totals.get(k) + cents);
    evidence.get(k).push({ ...payment, amount: amount(cents) });
    if (cents < 0n && !holds.get(k).has('refund_or_credit')) {   // O2
      hold([k], { paymentId: payment.id, reason: 'Refund or credit', code: 'refund_or_credit', nextStep: NEXT_STEP.refund_or_credit() });
    }
  }

  // ---- D9: possible duplicate payments (different IDs, same vendor/invoice/amount) ----------
  const signals = [];
  for (const [k, list] of evidence) {
    // Only when the invoice is overpaid: equal split payments that add up to the bill are normal.
    if (totals.get(k) <= invoiceMap.get(k).cents) continue;
    const groups = new Map();
    for (const p of list) {
      if (p.amount.startsWith('-')) continue;
      const g = groups.get(p.amount) || []; g.push(p); groups.set(p.amount, g);
    }
    for (const [amt, group] of groups) if (group.length > 1) {
      signals.push({ code: 'possible_duplicate_payment', invoiceId: invoiceMap.get(k).id, paymentIds: group.map(p => p.id), amount: amt,
        nextStep: 'Check whether one of these payments was voided, returned or refunded. If not, request a refund or credit from the vendor.' });
    }
  }

  // ---- L1: possible duplicate bills (same vendor + printed invoice number) ------------------
  const billGroups = new Map();
  for (const [k, inv] of invoiceMap) if (inv.invoiceNumber) {
    const g = `${key(inv.vendorId)}|${key(inv.invoiceNumber)}`;
    if (!billGroups.has(g)) billGroups.set(g, []);
    billGroups.get(g).push(k);
  }
  const duplicateOf = new Map();
  for (const ks of billGroups.values()) if (ks.length > 1) {
    const paidCopies = ks.filter(k => totals.get(k) > 0n);
    const combined = ks.reduce((s, k) => s + totals.get(k), 0n);
    const largest = ks.reduce((m, k) => (invoiceMap.get(k).cents > m ? invoiceMap.get(k).cents : m), 0n);
    const info = {
      code: 'possible_duplicate_bill',
      invoiceNumber: invoiceMap.get(ks[0]).invoiceNumber,
      vendorId: invoiceMap.get(ks[0]).vendorId,
      invoiceIds: ks.map(k => invoiceMap.get(k).id),
      paidCopies: paidCopies.length,
      combinedPaid: amount(combined),
      excessIfOneBill: amount(combined - largest),
      nextStep: paidCopies.length > 1
        ? 'The same vendor bill appears to be paid more than once. Confirm with the vendor statement, then request a refund or credit.'
        : 'Do not pay the unpaid copy until the vendor confirms these are separate bills.',
    };
    signals.push(info);
    for (const k of ks) duplicateOf.set(k, info);
  }

  // ---- Results -------------------------------------------------------------------------------
  const results = [...invoiceMap.entries()].map(([k, inv]) => {
    const total = totals.get(k);
    const diff = total - inv.cents;
    const held = holds.get(k);
    let status = diff > 0n ? 'Overpaid' : diff < 0n ? 'Remaining balance' : 'Paid in full';
    if (duplicateOf.has(k)) status = 'Possible duplicate bill';
    if (held.size) status = 'Needs review';
    return {
      invoiceId: inv.id,
      vendorId: inv.vendorId,
      invoiceNumber: inv.invoiceNumber,
      invoiceAmount: amount(inv.cents),
      matchedPaymentTotal: amount(total),
      difference: held.size ? null : amount(diff),
      status,
      heldFor: [...held],
      duplicateBill: duplicateOf.get(k) || null,
      payments: evidence.get(k),
    };
  });

  return { companyId, asOf, currency: 'USD', skippedDuplicates, excludedAfterCutoff, issues, signals, results };
}
