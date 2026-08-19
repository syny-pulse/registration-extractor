import { NextResponse } from "next/server";
import type { NextAuthConfig } from "next-auth";

/**
 * The edge-safe half of the Auth.js configuration.
 *
 * This module is imported by middleware.ts, which runs on the edge runtime.
 * It must not import bcrypt, the Neon driver, or anything else Node-only —
 * doing so breaks the middleware bundle in ways that only show up at deploy
 * time. The Credentials provider (and therefore all database access) lives in
 * auth.ts instead; `providers: []` here is deliberate, not an oversight.
 */
export const authConfig = {
  // JWT rather than a database session, so middleware can authorize a request
  // by reading the cookie alone — no database round trip on every navigation.
  session: { strategy: "jwt" },

  pages: {
    signIn: "/login",
    error: "/login",
  },

  callbacks: {
    /**
     * The cheap gate. It decides who may reach a route at all; it is not the
     * authority on what they may do once there. Because the role travels in a
     * JWT it can be stale — an admin demoted five minutes ago still carries
     * `role: "admin"` until their token refreshes. Every /api/admin handler
     * therefore re-reads the role from the database before acting. See
     * requireAdmin() in src/lib/guards.ts.
     */
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const token = auth?.user;

      const isAdminArea =
        pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
      const isProtected =
        isAdminArea ||
        pathname.startsWith("/extract") ||
        pathname.startsWith("/api/extract");

      if (!isProtected) return true;

      // Returning plain `false` sends a redirect to the login page, which is
      // right for a browser navigation and wrong for fetch(): the caller would
      // get 200 and a page of HTML instead of an error it can read. API routes
      // get a status code and JSON.
      const isApi = pathname.startsWith("/api/");

      if (!token) {
        return isApi
          ? NextResponse.json({ error: "Not signed in." }, { status: 401 })
          : false;
      }

      if (isAdminArea && token.role !== "admin") {
        return isApi
          ? NextResponse.json({ error: "Admin access required." }, { status: 403 })
          : NextResponse.redirect(new URL("/extract", request.nextUrl));
      }

      return true;
    },

    jwt({ token, user }) {
      // `user` is only present on the sign-in pass; afterwards the claims are
      // already on the token.
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role?: string }).role ?? "user";
      }
      return token;
    },

    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as "admin" | "user";
      }
      return session;
    },
  },

  providers: [],
} satisfies NextAuthConfig;
