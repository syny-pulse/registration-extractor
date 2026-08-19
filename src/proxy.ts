import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

/**
 * Route gating, running before every matched request.
 *
 * Next 16 calls this convention `proxy` (it was `middleware` through 15). It is
 * built from the edge-safe config only — see the note at the top of
 * auth.config.ts for why it cannot import ./auth.
 *
 * This is the cheap gate, not the authority: it reads a JWT, which can carry a
 * stale role. Every /api/admin handler re-reads the role from the database.
 */
export const { auth: proxy } = NextAuth(authConfig);

export default proxy;

export const config = {
  matcher: ["/extract/:path*", "/admin/:path*", "/api/extract", "/api/admin/:path*"],
};
