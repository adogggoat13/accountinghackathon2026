// Overpayment Review — browser app. All matching and arithmetic happens in engine/review.mjs.
// This file only loads records, calls the engine, and displays the result.
import { reviewInvoices } from '/engine/review.mjs';

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
};
const usd = s => {
  if (s == null) return '—';
  const neg = s.startsWith('-'); const [w, c] = s.replace('-', '').split('.');
  return `${neg ? '−' : ''}$${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${c}`;
};
const STORE = 'overpayment-review-v1';
const loadReviews = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } };
const saveReviews = v => { try { localStorage.setItem(STORE, JSON.stringify(v)); return true; } catch { return false; } };

// ---------------- CSV (small RFC 4180 parser; the starter's lib/csv.js is Node-only) ----------------
function parseCSV(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else f += c;
  }
  if (q) throw new Error('A quoted field is never closed');
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  if (!head.length || head.every(h => !h)) throw new Error('The file has no header row');
  return rows.filter(r => r.some(v => v.trim())).map((r, i) => {
    if (r.length !== head.length) throw new Error(`Row ${i + 2} has ${r.length} fields; the header has ${head.length}`);
    return Object.fromEntries(head.map((h, j) => [h, r[j]]));
  });
}
const pick = (row, names) => { for (const n of names) if (row[n] !== undefined && row[n] !== '') return row[n]; return undefined; };
const COLS = {
  invId: ['invoice_id', 'record_id', 'id'], vendor: ['vendor_id', 'vendor'], amount: ['amount', 'amount_usd', 'invoice_amount'],
  number: ['invoice_number', 'invoice_no', 'vendor_invoice_number'], vname: ['vendor_name', 'vendor'], cur: ['currency'],
  payId: ['payment_id', 'record_id', 'id'], payInv: ['invoice_id', 'invoice_record_id', 'invoice_reference'], date: ['payment_date', 'date'],
};
function mapInvoices(rows) {
  const need = (r, k, label, i) => { const v = pick(r, COLS[k]); if (v === undefined) throw new Error(`Invoices row ${i + 2}: missing ${label}`); return v; };
  return rows.map((r, i) => ({ id: need(r, 'invId', 'invoice_id', i), vendorId: need(r, 'vendor', 'vendor_id', i), amount: need(r, 'amount', 'amount', i),
    invoiceNumber: pick(r, COLS.number), vendorName: pick(r, COLS.vname), currency: pick(r, COLS.cur) || 'USD' }));
}
function mapPayments(rows) {
  const need = (r, k, label, i) => { const v = pick(r, COLS[k]); if (v === undefined) throw new Error(`Payments row ${i + 2}: missing ${label}`); return v; };
  return rows.map((r, i) => ({ id: need(r, 'payId', 'payment_id', i), vendorId: need(r, 'vendor', 'vendor_id', i), amount: need(r, 'amount', 'amount', i),
    date: need(r, 'date', 'payment_date', i), invoiceId: pick(r, COLS.payInv) || null, currency: pick(r, COLS.cur) || 'USD' }));
}

// ---------------- State ----------------
let current = null;   // { label, sourceKey, input, output, names, assumption }
let filter = 'attention';
let openId = null;

function showError(msg) { const e = $('#error'); e.textContent = msg; e.hidden = !msg; }

function run(label, sourceKey, input, names = {}, assumption = null) {
  showError('');
  let output;
  try { output = reviewInvoices(input); }
  catch (err) { showError(err.message); return; }
  current = { label, sourceKey, input, output, names, assumption };
  $('#source-label').textContent = label;
  openId = null; $('#case').hidden = true;
  const att = output.results.filter(needsAttention).length;
  filter = att ? 'attention' : 'all';
  renderFindings();
  if (output.results.length === 1) openCase(output.results[0].invoiceId);
  else $('#findings').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------- Sources ----------------
document.querySelectorAll('.source').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.source').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  for (const s of ['manual', 'real', 'sample', 'upload']) $(`#body-${s}`).hidden = s !== b.dataset.source;
  showError('');
}));

// Manual entry
const payBox = $('#manual-payments'); let payN = 0;
function addPayment(v = {}) {
  payN++;
  const row = el('div', { class: 'pay-row' },
    el('label', {}, 'Payment ID', el('input', { 'data-f': 'id', value: v.id || `PAY-${payN}`, autocomplete: 'off' })),
    el('label', {}, 'Paid to invoice number', el('input', { 'data-f': 'invoiceRef', value: v.invoiceRef ?? 'INV-1042', autocomplete: 'off', placeholder: 'blank = not linked' })),
    el('label', {}, 'Date paid', el('input', { 'data-f': 'date', type: 'date', value: v.date || '2026-11-01' })),
    el('label', {}, 'Amount paid (USD)', el('input', { 'data-f': 'amount', class: 'money', inputmode: 'decimal', value: v.amount || '', autocomplete: 'off' })),
    el('button', { type: 'button', class: 'ghost remove', onclick: () => row.remove(), 'aria-label': 'Remove this payment' }, 'Remove'));
  payBox.append(row);
}
$('#add-payment').addEventListener('click', () => addPayment({ amount: '' }));
addPayment({ id: 'PAY-1', amount: '6000.00', date: '2026-10-28' });
addPayment({ id: 'PAY-2', amount: '4000.00', date: '2026-10-29' });
$('#manual').addEventListener('submit', e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const vendorId = String(f.get('vendorId') || '').trim(); const num = String(f.get('invoiceNumber') || '').trim();
  const payments = [...payBox.children].map(r => {
    const g = k => r.querySelector(`[data-f="${k}"]`).value;
    const ref = g('invoiceRef').trim();
    // In manual mode the typed invoice number is the link. A blank reference means "not linked".
    return { id: g('id'), vendorId, invoiceId: ref ? (ref.toUpperCase() === num.toUpperCase() ? 'MANUAL-1' : ref) : null, date: g('date'), amount: g('amount'), currency: 'USD' };
  });
  run(`Typed in: invoice ${num || '(no number)'}`, 'manual', {
    companyId: 'MANUAL', asOf: String(f.get('asOf')),
    invoices: [{ id: 'MANUAL-1', vendorId, invoiceNumber: num, amount: String(f.get('amount')), currency: 'USD' }],
    payments,
  }, { [vendorId.toUpperCase()]: vendorId });
});

// Real case
$('#load-real').addEventListener('click', async () => {
  try {
    const rows = parseCSV(await (await fetch('/data/real/montgomery-bound-tree-85957920.csv')).text());
    run('Real public record · Montgomery County, MD', 'real', {
      companyId: 'MONTGOMERY-COUNTY-MD', asOf: '2025-10-31',
      invoices: [{ id: '85957920 line 1', vendorId: rows[0].vendor_id, invoiceNumber: rows[0].invoice_id, amount: rows[0].amount_usd, currency: 'USD' }],
      payments: rows.map(r => ({ id: r.payment_id, vendorId: r.vendor_id, invoiceId: '85957920 line 1', date: r.payment_date, amount: r.amount_usd, currency: 'USD', method: r.payment_method, status: r.payment_status })),
    }, { [rows[0].vendor_id]: 'Bound Tree Medical LLC' },
    'The public ledger lists payments, not the vendor’s bill. We assume this invoice line was billed once at $212.42, the amount on each payment row. Source: Montgomery County, MD “County Spending” open data, retrieved Nov 7, 2026.');
  } catch (err) { showError('Could not load the real case: ' + err.message); }
});

// Starter sample
$('#load-sample').addEventListener('click', async () => {
  try {
    const [inv, pay] = await Promise.all(['/data/invoices.csv', '/data/payments.csv'].map(async u => parseCSV(await (await fetch(u)).text())));
    const names = Object.fromEntries(inv.map(r => [r.vendor_id.toUpperCase(), r.vendor_name]));
    run('Starter data · 1,500 fictional invoices', 'sample', { companyId: 'CO-001', asOf: '2026-09-30', invoices: mapInvoices(inv), payments: mapPayments(pay) }, names);
  } catch (err) { showError('Could not load starter data: ' + err.message); }
});

// Upload
$('#load-upload').addEventListener('click', async () => {
  const fi = $('#file-invoices').files[0], fp = $('#file-payments').files[0];
  if (!fi || !fp) return showError('Choose both an invoices file and a payments file.');
  try {
    const inv = mapInvoices(parseCSV(await fi.text()));
    const pay = mapPayments(parseCSV(await fp.text()));
    const names = Object.fromEntries(inv.filter(r => r.vendorName).map(r => [r.vendorId.trim().toUpperCase(), r.vendorName]));
    run(`Uploaded · ${fi.name} + ${fp.name}`, `upload:${fi.name}`, { companyId: 'UPLOAD', asOf: $('#upload-asof').value, invoices: inv, payments: pay }, names);
  } catch (err) { showError(err.message); }
});

// ---------------- Findings ----------------
const STATUS_CLASS = { 'Overpaid': 's-over', 'Needs review': 's-review', 'Possible duplicate bill': 's-dup', 'Paid in full': 's-ok', 'Remaining balance': 's-bal' };
const RANK = { 'Overpaid': 0, 'Possible duplicate bill': 1, 'Needs review': 2, 'Remaining balance': 3, 'Paid in full': 4 };
const cents = s => (s == null ? 0n : BigInt(s.replace('.', '')));
function needsAttention(r) { return r.status === 'Overpaid' || r.status === 'Needs review' || (r.status === 'Possible duplicate bill' && r.duplicateBill?.paidCopies > 0); }
function excessOf(r) {
  if (r.status === 'Possible duplicate bill') return cents(r.duplicateBill.excessIfOneBill);
  return r.difference && !r.difference.startsWith('-') ? cents(r.difference) : 0n;
}
const vendorName = r => current.names[r.vendorId.trim().toUpperCase()] || r.vendorId;

function renderFindings() {
  const { output } = current;
  const R = output.results;
  const by = s => R.filter(r => r.status === s);
  const sum = list => list.reduce((t, r) => t + excessOf(r), 0n);
  const fmt = c => usd((c < 0n ? '-' : '') + (c < 0n ? -c : c).toString().padStart(3, '0').replace(/(\d\d)$/, '.$1'));
  const dupGroups = output.signals.filter(s => s.code === 'possible_duplicate_bill');
  const dupPaidTwice = dupGroups.filter(g => g.paidCopies > 1);
  const counts = [
    ['Invoices checked', R.length.toLocaleString()],
    ['Overpaid', by('Overpaid').length, fmt(sum(by('Overpaid')))],
    ['Possible duplicate bills', dupGroups.length, `${by('Possible duplicate bill').length} records · ` + (dupPaidTwice.length ? `${dupPaidTwice.length} paid twice` : 'none paid twice')],
    ['Needs review', by('Needs review').length],
    ['Remaining balance', by('Remaining balance').length.toLocaleString()],
    ['Paid in full', by('Paid in full').length.toLocaleString()],
  ];
  $('#counts').replaceChildren(...counts.map(([k, v, s]) => el('div', {}, el('dt', { text: k }), el('dd', {}, String(v), s ? el('small', { text: s }) : null))));
  $('#findings-asof').textContent = `Reviewed through ${output.asOf}` + (output.skippedDuplicates ? ` · ${output.skippedDuplicates} repeated payment record(s) counted once` : '') + (output.excludedAfterCutoff.length ? ` · ${output.excludedAfterCutoff.length} payment(s) after that date left out` : '');

  // Pattern: many overpayments with the identical excess usually share one cause.
  const over = by('Overpaid'); const tally = new Map();
  for (const r of over) tally.set(r.difference, (tally.get(r.difference) || 0) + 1);
  const [topAmt, topN] = [...tally].sort((a, b) => b[1] - a[1])[0] || [];
  const pat = $('#pattern');
  if (topN >= 3) { pat.hidden = false; pat.textContent = `${topN} of ${over.length} overpaid invoices are over by exactly ${usd(topAmt)}. An identical excess across many vendors usually points to one cause, such as a fee or tax added twice. Review them together.`; }
  else pat.hidden = true;

  const tabs = [['attention', 'Needs attention', R.filter(needsAttention).length], ['Overpaid', 'Overpaid', over.length], ['Possible duplicate bill', 'Duplicate-bill records', by('Possible duplicate bill').length], ['Needs review', 'Needs review', by('Needs review').length], ['all', 'All', R.length]];
  $('#filters').replaceChildren(...tabs.map(([k, label, n]) => el('button', { role: 'tab', 'aria-selected': String(filter === k), onclick: () => { filter = k; renderFindings(); } }, `${label} (${n})`)));

  const list = R.filter(r => filter === 'all' ? true : filter === 'attention' ? needsAttention(r) : r.status === filter)
    .sort((a, b) => (RANK[a.status] - RANK[b.status]) || (excessOf(b) > excessOf(a) ? 1 : excessOf(b) < excessOf(a) ? -1 : 0) || a.invoiceId.localeCompare(b.invoiceId));
  const LIMIT = 300; const reviews = loadReviews();
  $('#queue').replaceChildren(...list.slice(0, LIMIT).map(r => {
    const rev = reviews[caseKey(r.invoiceId)]?.at(-1);
    const diffCell = r.status === 'Possible duplicate bill' ? usd(r.duplicateBill.excessIfOneBill) : usd(r.difference);
    return el('tr', { class: 'row', tabindex: '0', onclick: () => openCase(r.invoiceId), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCase(r.invoiceId); } } },
      el('td', {}, el('span', { class: `status ${STATUS_CLASS[r.status]}`, text: r.status }), rev ? el('span', { class: 'sub reviewed', text: `Reviewed: ${rev.decision}` }) : null),
      el('td', {}, vendorName(r), el('span', { class: 'sub', text: r.vendorId })),
      el('td', {}, r.invoiceNumber || r.invoiceId, el('span', { class: 'sub', text: r.invoiceNumber ? r.invoiceId : '' })),
      el('td', { class: 'num', text: usd(r.invoiceAmount) }),
      el('td', { class: 'num', text: usd(r.matchedPaymentTotal) }),
      el('td', { class: `num ${excessOf(r) > 0n ? 'pos' : ''}`, text: r.status === 'Needs review' ? 'Held' : diffCell }));
  }));
  $('#queue-note').textContent = list.length > LIMIT ? `Showing the first ${LIMIT} of ${list.length}. Use the filters to narrow the list.` : list.length ? 'Select a row to see its records and next steps.' : 'Nothing in this view.';
  $('#findings').hidden = false;
}

// ---------------- Case ----------------
const caseKey = id => `${current.sourceKey}|${id}`;
function openCase(id) {
  openId = id;
  const { output } = current;
  const r = output.results.find(x => x.invoiceId === id);
  const issues = output.issues.filter(i => i.affects.includes(id));
  const sigs = output.signals.filter(s => s.invoiceId === id || s.invoiceIds?.includes(id));
  const cls = { 'Overpaid': 'over', 'Needs review': 'review', 'Possible duplicate bill': 'dup', 'Paid in full': 'ok' }[r.status] || '';
  let headline = r.status;
  if (r.status === 'Overpaid') headline = `Overpaid by ${usd(r.difference)}`;
  if (r.status === 'Remaining balance') headline = `Remaining balance ${usd(r.difference.replace('-', ''))}`;
  if (r.status === 'Possible duplicate bill') headline = r.duplicateBill.paidCopies > 1 ? `Same bill paid ${r.duplicateBill.paidCopies} times — ${usd(r.duplicateBill.excessIfOneBill)} extra` : 'Possible duplicate bill — do not pay the copy';

  const ledger = el('table', { class: 'ledger' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Record' }), el('th', { text: 'Date' }), el('th', { class: 'num', text: 'Amount' }))),
    el('tbody', {},
      el('tr', {}, el('td', {}, `Invoice ${r.invoiceNumber || r.invoiceId}`, el('span', { class: 'sub hint', text: ` record ${r.invoiceId}` })), el('td', { text: '' }), el('td', { class: 'num', text: usd(r.invoiceAmount) })),
      ...r.payments.map(p => el('tr', { class: sigs.some(s => s.code === 'possible_duplicate_payment' && s.paymentIds.includes(p.id)) ? 'dupe' : '' },
        el('td', {}, `Payment ${p.id}`, p.method ? el('span', { class: 'sub hint', text: ` ${p.method} · ${String(p.status || '').toLowerCase()}` }) : null),
        el('td', { text: p.date }), el('td', { class: 'num', text: usd(p.amount) }))),
      el('tr', { class: 'total' }, el('td', { text: `Total paid (${r.payments.length} payment${r.payments.length === 1 ? '' : 's'})` }), el('td', { text: '' }), el('td', { class: 'num', text: usd(r.matchedPaymentTotal) })),
      el('tr', { class: 'diff' }, el('td', { text: 'Paid − billed' }), el('td', { text: '' }), el('td', { class: `num ${cls === 'over' ? 'pos' : ''}`, text: r.difference == null ? 'Held for review' : usd(r.difference) }))));

  const steps = [
    ...sigs.map(s => s.code === 'possible_duplicate_bill'
      ? [`Possible duplicate bill · ${s.invoiceIds.join(', ')}`, `Vendor ${s.vendorId} has ${s.invoiceIds.length} records for invoice ${s.invoiceNumber}; ${s.paidCopies} paid, ${usd(s.combinedPaid)} in total. ${s.nextStep}`]
      : [`Possible duplicate payment · ${s.paymentIds.join(' and ')}`, `${s.paymentIds.length} payments of ${usd(s.amount)} each. ${s.nextStep}`]),
    ...issues.map(i => [`${i.reason} · payment ${i.paymentId}`, i.nextStep]),
  ];
  if (!steps.length) steps.push([r.status === 'Overpaid' ? 'Overpayment' : 'No action needed', r.status === 'Overpaid' ? 'Confirm against the vendor statement, then request a refund or a credit on the next invoice.' : 'The linked payments match the records shown.']);

  $('#case-body').replaceChildren(el('div', { class: 'case-grid' },
    el('div', {},
      el('p', { class: 'eyebrow', text: vendorName(r).toUpperCase() }),
      el('p', { class: `verdict ${cls}`, text: headline }),
      el('dl', { class: 'facts' }, el('dt', { text: 'Vendor' }), el('dd', { text: `${vendorName(r)} (${r.vendorId})` }), el('dt', { text: 'Invoice' }), el('dd', { text: r.invoiceNumber || r.invoiceId }), el('dt', { text: 'Data' }), el('dd', { text: current.label })),
      ledger,
      current.assumption ? el('p', { class: 'assume', text: current.assumption }) : null),
    el('aside', { class: 'steps', 'aria-label': 'Recommended next steps' }, el('h3', { text: 'Recommended next step' }), ...steps.map(([t, d]) => el('div', { class: 'step' }, el('b', { text: t }), d)))));
  $('#decision-choice').value = r.status === 'Overpaid' || (r.status === 'Possible duplicate bill' && r.duplicateBill.paidCopies > 1) ? 'Request refund or credit from vendor' : '';
  $('#decision-note').value = ''; $('#decision-msg').textContent = '';
  renderHistory();
  $('#case').hidden = false;
  $('#case').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderHistory() {
  const list = loadReviews()[caseKey(openId)] || [];
  $('#history').replaceChildren(...(list.length ? [el('h3', { text: 'Saved reviews' })] : []), ...[...list].reverse().map(h =>
    el('div', { class: 'history-item' }, el('b', { text: h.decision }), ` · ${new Date(h.savedAt).toLocaleString()} · figures at save: paid ${usd(h.paid)}, difference ${usd(h.difference)}`, h.note ? el('div', { text: h.note }) : null)));
}
$('#close-case').addEventListener('click', () => { $('#case').hidden = true; $('#findings').scrollIntoView({ behavior: 'smooth' }); });
$('#decision').addEventListener('submit', e => {
  e.preventDefault();
  const decision = $('#decision-choice').value; const note = $('#decision-note').value.trim();
  if (!decision) { $('#decision-msg').textContent = 'Choose a decision first.'; return; }
  const r = current.output.results.find(x => x.invoiceId === openId);
  const all = loadReviews(); const k = caseKey(openId);
  // The decision is stored beside a copy of the figures; saving never changes the calculation (DECISIONS D5).
  (all[k] ||= []).push({ decision, note, savedAt: new Date().toISOString(), status: r.status, paid: r.matchedPaymentTotal, difference: r.difference, billed: r.invoiceAmount });
  $('#decision-msg').textContent = saveReviews(all) ? 'Saved in this browser with the figures shown above.' : 'Could not save: browser storage is unavailable.';
  renderHistory(); renderFindings();
});
