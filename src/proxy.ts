import { auth } from "@/server/auth/edge-config";
import { NextResponse } from "next/server";

const ADMIN_ONLY_PREFIXES = ["/users", "/settings"];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;
  const isAuthPage = pathname.startsWith("/login");

  if (!isLoggedIn && !isAuthPage) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isLoggedIn && isAuthPage) {
    return NextResponse.redirect(new URL("/start", req.nextUrl.origin));
  }

  if (isLoggedIn && ADMIN_ONLY_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (req.auth?.user?.role !== "ADMIN") {
      return NextResponse.redirect(new URL("/dashboard?denied=1", req.nextUrl.origin));
    }
    
  }

  return NextResponse.next();
});

export const config = {
  // Skip auth for API routes, Next internals, uploads and any static file in /public (logo, images, fonts...).
  // Without the file-extension rule, /atec-apic-logo.png etc. were redirected to /login for logged-out visitors,
  // so the splash/login logo showed as a broken image on first open.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|uploads|.*\\.(?:png|jpg|jpeg|gif|svg|webp|avif|ico|woff2?|ttf|otf|txt|xml|json|webmanifest)$).*)"],
};
