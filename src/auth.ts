import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import { authConfig } from "./auth.config";
import { verifyCredentials } from "./lib/users";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * The Node half of the configuration: everything that touches bcrypt or the
 * database. Route handlers and server components import from here; middleware
 * imports auth.config.ts instead.
 *
 * There is no sign-up provider and no email flow, by design — accounts exist
 * only because an admin created them.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const user = await verifyCredentials(parsed.data.email, parsed.data.password);
        if (!user) return null;

        // Only identity travels into the token. Credits are read fresh from the
        // database wherever they are needed, so a balance can never be spent
        // from a stale claim.
        return { id: user.id, email: user.email, role: user.role };
      },
    }),
  ],
});
