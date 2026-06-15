import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";

function isApi(pathname: string): boolean {
  return pathname.startsWith("/api");
}
function isApp(pathname: string): boolean {
  return pathname.startsWith("/app");
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public NextAuth handler must stay open.
  if (pathname.startsWith("/api/auth")) return NextResponse.next();
  // Public liveness probe (no auth, no secrets).
  if (pathname === "/api/health") return NextResponse.next();
  // Public sign-in page.
  if (pathname.startsWith("/signin")) return NextResponse.next();

  if (!isApi(pathname) && !isApp(pathname)) return NextResponse.next();

  // Optional: only accept requests that came through Cloudflare.
  // Combine with iptables/ufw that restrict origin to Cloudflare IPs for real enforcement.
  if (process.env.REQUIRE_CLOUDFLARE === "true") {
    const cf = req.headers.get("cf-connecting-ip");
    if (!cf) {
      if (isApi(pathname)) {
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Direct origin access denied" } },
          { status: 403 }
        );
      }
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // Personal Access Token (PAT) requests authenticate at the route layer
  // (nodejs runtime). Edge middleware can't verify PATs (node:crypto / ioredis),
  // so defer API requests carrying a Bearer PAT — the route re-authenticates and
  // rejects invalid tokens. Only our token format bypasses the cookie gate.
  if (isApi(pathname) && /^Bearer\s+dbm_pat_/i.test(req.headers.get("authorization") ?? "")) {
    return NextResponse.next();
  }

  const session = await auth();
  if (!session?.user) {
    if (isApi(pathname)) {
      return NextResponse.json(
        { error: { code: "UNAUTH", message: "Sign-in required" } },
        { status: 401 }
      );
    }
    // Preserve the full path + query (e.g. ?share=<token>) so share links survive login.
    const next = pathname + req.nextUrl.search;
    const url = req.nextUrl.clone();
    url.pathname = "/signin";
    url.search = "";
    url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*", "/api/:path*"]
};
