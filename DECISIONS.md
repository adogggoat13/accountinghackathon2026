# Decisions

RedHawk Builds 2026 · Challenge #10: Purchasing and Expense Controls · Invoice overpayment review

This file records each rule the app follows, why we chose it, and how we tested it. Each entry is marked **Decided**, **Open** (still to agree) or **Limitation** (known gap we chose not to solve this weekend).

---

## Scope

**The question the app answers:**
> For this company, vendor and invoice, do the posted USD payments explicitly linked to the invoice, through the selected date, exceed the amount billed, and by exactly how much?

**User:** an accounts payable reviewer following up after payments have posted.

**Out of scope this weekend:** non-USD currencies, PDF extraction, bank connections, sending payments or emails automatically, arbitrary spreadsheet formats (stretch goal), fraud determination.

A positive difference means the supplied records show payments above the billed amount. It does **not** by itself prove fraud, that the money can be recovered, or why it happened. Those need more evidence.

---

## D1 · Match payments by identifiers, not by amount · Decided

**Rule:** A payment counts toward an invoice only when it references that invoice and the same vendor. In the starter data, each payment row in `data/payments.csv` carries `invoice_record_id` (for example `AP-00019`) and the vendor ID (for example `VEN-019`).

**Why:** The same invoice number can appear under different vendors (two vendors can both issue invoice 1042). Matching on dollar amounts alone would link the wrong records.

**Tested:** Vendor mismatch case, same invoice number under two vendors.

---

## D2 · Calculate the difference in integer cents · Decided

**Rule:** `Difference = total linked payments − invoice amount`, calculated in whole cents using the starter pack's exact-money utilities (no floating-point math).

| Difference | Status shown |
|---|---|
| Greater than $0.00 | **Overpaid by $X** |
| Exactly $0.00 | **Paid in full** |
| Less than $0.00 | **Balance remaining $X** |

**Why:** Floating-point math can produce errors like $0.01 off on large totals. Cents are exact.

**Note:** A remaining balance alone does not mean the invoice is overdue. That depends on terms and due date.

**Tested (worked by hand first):**
- Invoice `VEN-019-00019`, Maple Advisory 19, billed **$25,263.67**. Payments `PAY-00019-1` **$12,631.83** (Feb 22, 2026) + `PAY-00019-2` **$12,631.84** (Feb 23, 2026) = $25,263.67 → **Paid in full, $0.00**.
- Same invoice, second payment changed to $12,881.84 → total $25,513.67 → **Overpaid by $250.00**.
- One-cent overpayment case.

---

## D3 · Hold unclear payments for review · Decided

**Rule:** If a payment can't be matched confidently (missing invoice reference, unknown invoice, vendor mismatch), the app shows **Needs review** instead of a verdict and names the information that's missing.

**Why:** Guessing where a payment belongs could create a false overpayment flag. Our target is zero false flags.

**Recommended next steps shown to the reviewer:**

| Reason held | Recommended next step |
|---|---|
| Missing invoice reference | Get the allocation from the remittance advice or payment register |
| Unknown invoice | Find the referenced invoice and confirm its company and vendor |
| Vendor mismatch | Check the vendor against the vendor master and remittance advice |
| Conflicting payment records | Compare the versions against the payment register before correcting |

These come from fixed rules in code, not AI.

**Tested:** Missing reference case.

---

## D4 · Count each payment ID once · Decided

**Rule:**
- The same payment ID imported twice with identical details → counted **once**.
- The same payment ID with a different amount or invoice reference → **Needs review** (conflict).
- Two different payment IDs with the same amount → **both count**. Equal amounts can be legitimate.

**Why:** Re-importing a file must never raise the total. But deleting payments just because the amounts match would hide real duplicate payments.

**Tested:** Identical repeat, conflicting repeat, equal amounts under different IDs.

---

## D5 · Calculations stay in code; reviewer decisions stay separate · Decided

**Rule:** Matching and arithmetic are deterministic code. The reviewer's decision and note are stored separately from the calculated figures, so marking a case reviewed can never change its numbers.

**Why:** Judges and auditors need to trust that the figures come from the records, not from an edit or an AI.

**Current storage:** Saved reviews live in the browser (localStorage) and survive a page reload. Supabase is a later step.

**Tested:** Saving a review preserves its figures, decision and note after reload.

---

## D6 · Missing or invalid inputs are errors, never zero · Decided

**Rule:** A blank or non-numeric amount is reported as an error with the row number. It is never treated as $0.00.

**Why:** Treating a blank as zero would silently create or hide an overpayment.

**Tested:** Invalid amount case.

---

## D7 · Cutoff date · Implemented, awaiting team OK

**Rule:** Results are calculated "as of" a selected date. Payments after that date are excluded.

**Implemented (claude/engine-fixes):** a payment dated **on** the cutoff date is included. Test C1.

---

## O1 · One unclear payment holds what? · Implemented, awaiting team OK

**Current behavior:** One unresolved payment holds the **whole batch** for review.

**Proposed:** Hold only the **affected invoice**. Every other invoice still gets its result.

**Why it matters:** In a real company file, one bad row would otherwise freeze every result. That would break the demo with a judge's data.

**Implemented (claude/engine-fixes):** an unclear payment holds only the invoices it could belong to: the referenced invoice and that vendor's invoices. Each issue lists what it `affects`. Test B3.

---

## O2 · Refunds, credits and reversals · Implemented, awaiting team OK

**Question:** If a vendor refunds $250, does that cancel a $250 overpayment?

**Proposed for this weekend:** Hold any invoice with a refund, credit or reversal for review, with the next step "Confirm the refund in the payment register." Reason: interpreting credits wrong could create false flags.

**Implemented (claude/engine-fixes):** negative amounts are accepted and netted into the total, and the invoice is held for review with that next step. Real ledgers record credits as negative rows (Montgomery County does). Test C2.

---

## O3 · Messy amounts in uploaded CSVs · Implemented, awaiting team OK

**Implemented (claude/engine-fixes):** `parseMoney()` handles every row below exactly as proposed; `(250.00)` is negative and so is held under O2. Errors name the row. Test B5, A11.

**Decide and test how each is handled:**

| Input | Proposed handling |
|---|---|
| `1234.50` | Parse → $1,234.50 |
| `$1,234.50` | Parse → $1,234.50 |
| `1234.5` | Parse → $1,234.50 |
| `(250.00)` | Treat as negative, or hold for review |
| blank | Error (D6) |
| `abc` | Error (D6) |
| More than 2 decimal places | Error, don't round silently |

---

## D8 · IDs are compared trimmed and case-insensitive · Implemented, awaiting team OK

**Rule:** Payment, invoice and vendor IDs are compared after trimming spaces and ignoring capitals. `PAY-1 `, `pay-1` and `PAY-1` are one payment.

**Why:** Without this, a re-imported export with a padded ID produced a **false overpayment of $12,631.84**, breaking the zero-false-flag target. Test B1, B2.

---

## D9 · Possible duplicate payment signal · Implemented, awaiting team OK

**Rule:** When an invoice is overpaid and two or more different payment IDs paid it the same amount, the app adds a **possible duplicate payment** signal with the next step "Check whether one was voided, returned or refunded; if not, request a refund or credit." Equal split payments that add up to the bill raise nothing.

**Why:** This is the pattern in real data: Montgomery County, MD paid Bound Tree Medical invoice 85957920 $212.42 on Oct 28 and again on Oct 29, 2025. Test C3, C4, E1.

---

## Known limitations

- **L1 · Fixed on claude/engine-fixes.** Invoices with the same vendor and printed invoice number show **Possible duplicate bill**, with how many copies were paid and the excess if they are one bill. Catches all 15 starter duplicates. Requires the optional `invoiceNumber` field. Test B4, D1.
- **L2 · Payments must be linked to invoices in the data.** The app does not guess allocations for payments that cover several invoices without a breakdown. Those are held for review.
- **L3 · Saved reviews are in browser storage.** They are not access-controlled or tamper-proof like a production audit trail.
- **L4 · USD only.**
- **L5 · Demo data is synthetic** (RedHawk Builds Starter Pack v1.2) unless we have permission to use redacted company records. Any real data used will be labeled with its source.

---

## How we verify accuracy

- **Target:** exact-to-the-cent results and zero false overpayment flags on our stated test set.
- **We report:** overpayments caught, overpayments missed, false flags, and cases held for review, with the test size.
- **Answer keys** (including the starter pack's `validation/` folder) are kept out of the detection code and AI inputs and used only to check results afterward.
- **Test set:** exact payment, split payment, overpaid by $250, overpaid by $0.01, same invoice number under two vendors, missing reference, identical repeat import, conflicting repeat, payment after cutoff, invalid amount.
- **Current status:** 22 engine tests passing (`tests/review.test.js`), plus 18 starter tests. Full starter data: 40/40 overpayments found, 0 missed, 0 false flags; 15/15 duplicate bills flagged. Real data: Montgomery County, MD invoice 85957920 flagged (test E1).
- **Usability check:** someone outside the team finds the overpayment, shows the evidence and saves a decision without help.

---

## Who did what

- **Starter pack provided:** synthetic invoices (1,500), payments (1,424), vendor documents, exact-money utilities, baseline overpayment rule.
- **Our team built:** identifier matching, hold-for-review rules and next steps, duplicate-import handling, the review screen, saved decisions, CSV import, the test set and answer key.
- **AI tools used:** Codex (implementation), Claude (accuracy review and edge cases), Grokbot (business case and demo review). Every rule above was reviewed and approved by the team.
