
# Accounting Hackathon 2026

## Project
Invoice Overpayment Detection & Investigation

## Our Mission
Build a secure financial review tool that helps companies identify potential invoice overpayments and investigate discrepancies.

## Core Features
- Upload invoice and payment CSV files
- Detect overpayments to the exact cent
- Identify duplicate and unmatched payments
- Recommend next steps for investigations
- Save analyst review decisions
- Support manual entry of financial records

## Our Team
Four developers collaborating through GitHub.

## Hackathon
Redhawk Builds 2026

## Current Status
Prototype development in progress.

## Run the review website
Requires Node.js 22+. From this folder:

```
npm ci
npm test          # 40 checks, including the engine tests
npm run dev       # then open http://127.0.0.1:4180/
```

Four ways in: type numbers (judge demo), the real Montgomery County, MD case, the 1,500-invoice starter data, or upload two CSV files (templates in `app/samples/`). Everything runs on this computer; saved reviews stay in the browser.

- `engine/review.mjs`: matching and arithmetic (all rules in `DECISIONS.md`)
- `app/`: the website (`index.html`, `style.css`, `app.js`)
- `data/real/`: public record used for the real case
