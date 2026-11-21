# Pricing & Estimation (4 stages)

Page: `/projects/[id]/pricing` (new "Pricing" tab on the project). Separate from the older BOQ pricing at `/takeoff/pricing`, which is untouched.

## Flow
Material → Manufacturing (operations per item + Subcontractor) → Project costs → Commercial price → Create Offer.
All inputs are stored in `estimate_*` tables. Totals are never stored or accepted from the browser: the server recalculates with
`src/features/estimation/calc.ts`; the page runs the same functions for instant updates.

## Data sources (nothing is copied as separate data)
- Materials: `getMaterialRequirements` (nesting-sent materials, else Part List). Lines keep `sourceRef` + the source values of the last sync;
  edited quantities/prices survive re-sync. Price suggestion = weighted average of Procurement order prices.
- Items: project Scope items (weight/pieces live from their parts) + manual items.
- Offer: a normal `Quotation` (DRAFT). First offer = new number, later ones = next revision of that number. Never approved automatically.

## Formulas
- Material cost = purchased kg × unit price (scrap already inside). Recovered scrap is deducted only if "Credit recovered scrap" is on.
- Operation = qty × rate; qty from the item for per-kg / per-ton / per-piece, entered for per-m / hour / hole / custom. Percentage needs a base:
  other selected operations of the item, or the item's weight share of material cost.
- Project cost percentages apply to material, manufacturing, subcontractor, or their sum — never to other project costs.
- Price: profit (markup on cost | margin on price | fixed) → insurance (fixed | % of cost+profit) → tax % on cost+profit+insurance.

## Deploy
```
npm install
npx prisma generate
npx prisma migrate deploy      # applies 20260911090000_pricing_estimation (additive)
```
Permissions reuse `pricing.view` / `pricing.edit` (+ `quotations.edit` for Create Offer). No new env vars.

## Known limitations
- Download Quotation is a printable page (browser "Save as PDF"), not a server PDF.
- Per-meter / per-hole / per-hour quantities have no data source in Part List and are entered by hand.
- Last save wins is prevented by an `updatedAt` check (409 → reload), not by field-level merge.
- Operation rates are not pulled from the Rate Library yet; defaults start at 0 and unselected.
