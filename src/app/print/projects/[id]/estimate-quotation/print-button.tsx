"use client";
export function PrintButton() {
  return <button type="button" onClick={() => window.print()} className="mb-4 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white print:hidden">Print / Save as PDF</button>;
}
