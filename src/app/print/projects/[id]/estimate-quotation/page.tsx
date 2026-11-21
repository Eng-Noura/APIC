import { notFound } from "next/navigation";
import { auth } from "@/server/auth/config";
import { can } from "@/server/rbac/permissions";
import { getSavedEstimate, EstimationError } from "@/server/services/estimation.service";
import { PrintButton } from "./print-button";

const fmt = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Printable commercial quotation built from the SAVED estimate (browser "Save as PDF"). Customer-facing: it shows the price
// build-up (profit, insurance, tax) but not internal material / manufacturing costs.
export default async function EstimateQuotationPrint({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!can((await auth())?.user.role, "pricing.view")) notFound();
  let doc;
  try { doc = await getSavedEstimate(id); } catch (e) { if (e instanceof EstimationError) notFound(); throw e; }
  const { totals: t, settings: s, currency: cur } = doc;
  const today = new Date();
  const valid = new Date(today.getTime() + s.offerValidityDays * 86_400_000);
  const subtotal = t.costCents + t.profitCents;
  return (
    <div className="mx-auto max-w-3xl bg-white p-10 text-sm text-slate-900 print:p-0">
      <PrintButton />
      <header className="mb-6 flex items-start justify-between border-b-2 border-slate-800 pb-4">
        <div><h1 className="text-2xl font-bold">Commercial Quotation</h1><p className="text-slate-600">{doc.project.name} · {doc.project.number}</p></div>
        <div className="text-right text-xs text-slate-600"><div>Date: {today.toLocaleDateString("en-GB")}</div><div>Valid until: {valid.toLocaleDateString("en-GB")}</div></div>
      </header>
      <p className="mb-6">Customer: <b>{doc.project.customer || "—"}</b></p>
      <table className="mb-6 w-full border-collapse">
        <tbody>
          <tr className="border-b"><td className="py-2">Supply & fabrication{t.profitCents ? "" : ""}</td><td className="py-2 text-right tabular-nums">{fmt(subtotal)}</td></tr>
          {t.insuranceCents > 0 && <tr className="border-b"><td className="py-2">Insurance</td><td className="py-2 text-right tabular-nums">{fmt(t.insuranceCents)}</td></tr>}
          <tr className="border-b"><td className="py-2">Total before tax</td><td className="py-2 text-right tabular-nums">{fmt(t.taxableCents)}</td></tr>
          {s.taxPct > 0 && <tr className="border-b"><td className="py-2">Tax ({s.taxPct}%)</td><td className="py-2 text-right tabular-nums">{fmt(t.taxCents)}</td></tr>}
          <tr className="bg-slate-100 font-bold"><td className="px-2 py-3 text-base">Total price ({cur})</td><td className="px-2 py-3 text-right text-base tabular-nums">{fmt(t.finalCents)}</td></tr>
        </tbody>
      </table>
      <dl className="space-y-3">
        {s.paymentTerms && <div><dt className="font-semibold">Payment terms</dt><dd>{s.paymentTerms}</dd></div>}
        <div><dt className="font-semibold">Offer validity</dt><dd>{s.offerValidityDays} days</dd></div>
        {s.deliveryDays != null && <div><dt className="font-semibold">Delivery period</dt><dd>{s.deliveryDays} days</dd></div>}
        {s.exclusions && <div><dt className="font-semibold">Exclusions</dt><dd className="whitespace-pre-line">{s.exclusions}</dd></div>}
        {s.commercialNotes && <div><dt className="font-semibold">Notes</dt><dd className="whitespace-pre-line">{s.commercialNotes}</dd></div>}
      </dl>
      <p className="mt-10 text-xs text-slate-500">This is a draft quotation generated from the saved estimate and is not an approved offer until it is approved in Quotations.</p>
    </div>
  );
}
