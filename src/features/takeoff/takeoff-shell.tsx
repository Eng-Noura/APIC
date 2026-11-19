"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { TakeoffProjectProvider } from "./project-context";
import { WorkspaceBar } from "./workspace-bar";
import { ProjectGate } from "./project-gate";

function activeTabClass(isActive: boolean) {
  return isActive
    ? "border-b-2 border-primary px-1 pb-2 text-sm font-semibold text-foreground"
    : "px-1 pb-2 text-sm font-medium text-muted-foreground transition hover:text-foreground";
}

/** "2D Nesting" (2D) and "1D Nesting" are two views of the same page: `?view=1d` opens the 1D one. */
function NestingTabLinks({ isNesting }: { isNesting: boolean }) {
  const view = useSearchParams().get("view");
  const is1D = isNesting && view === "1d";
  return (
    <>
      <Link href="/takeoff/nesting" scroll={false} className={activeTabClass(isNesting && !is1D)}>
        2D Nesting
      </Link>
      <Link href="/takeoff/nesting?view=1d" scroll={false} className={activeTabClass(is1D)}>
        1D Nesting
      </Link>
    </>
  );
}

// showSteelPricing is unused while that tab is temporarily hidden.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function TakeoffTopBar({ showScrap }: { showScrap: boolean; showSteelPricing: boolean }) {
  const pathname = usePathname();
  const isNesting = pathname?.startsWith("/takeoff/nesting") ?? false;
  const isScrap = pathname?.startsWith("/takeoff/scrap-management") ?? false;
  const isSteelPricing = pathname?.startsWith("/takeoff/steel-pricing") ?? false;
  const isNozzles = pathname?.startsWith("/takeoff/nozzles") ?? false;
  const isStandard = !isNesting && !isScrap && !isSteelPricing && !isNozzles;

  return (
    <div className="space-y-4">
      <WorkspaceBar />

      <div className="flex gap-5 overflow-x-auto border-b border-border">
        <Link href="/takeoff" className={activeTabClass(isStandard)}>
          Part List
        </Link>
        <React.Suspense
          fallback={
            <>
              <Link href="/takeoff/nesting" scroll={false} className={activeTabClass(isNesting)}>2D Nesting</Link>
              <Link href="/takeoff/nesting?view=1d" scroll={false} className={activeTabClass(false)}>1D Nesting</Link>
            </>
          }
        >
          <NestingTabLinks isNesting={isNesting} />
        </React.Suspense>
        {showScrap && (
          <Link href="/takeoff/scrap-management" className={activeTabClass(isScrap)}>
            Scrap Management
          </Link>
        )}
        {/* TEMP-HIDDEN (Nozzles / Steel Pricing) - uncomment to restore, or delete for good later.
        <Link href="/takeoff/nozzles" className={activeTabClass(isNozzles)}>
          Nozzles
        </Link>
        {showSteelPricing && (
          <Link href="/takeoff/steel-pricing" className={activeTabClass(isSteelPricing)}>
            Steel Pricing
          </Link>
        )}
        */}
      </div>
    </div>
  );
}

export function TakeoffShell({
  children,
  showScrap = false,
  showSteelPricing = false,
}: {
  children: React.ReactNode;
  showScrap?: boolean;
  showSteelPricing?: boolean;
}) {
  return (
    <TakeoffProjectProvider>
      <div className="space-y-6">
        <TakeoffTopBar showScrap={showScrap} showSteelPricing={showSteelPricing} />
        <ProjectGate>{children}</ProjectGate>
      </div>
    </TakeoffProjectProvider>
  );
}
