/**
 * Loads environment variables for the standalone scripts.
 *
 * Next.js reads `.env.local` automatically, but plain `dotenv/config` does not —
 * it only looks at `.env`. Importing this instead of `dotenv/config` keeps the
 * scripts reading the same file the dev server does, rather than silently
 * seeing nothing while `.env.local` sits there fully filled in.
 *
 * First file wins, matching Next's own precedence.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
