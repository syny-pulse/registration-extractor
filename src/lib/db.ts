import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let client: NeonQueryFunction<false, false> | null = null;
let clientUrl: string | null = null;

/**
 * Resolved on first query rather than at import.
 *
 * Reading DATABASE_URL at module scope would make importing this file fail
 * without it, which takes down `next build` on any machine that has no database
 * configured — CI, a fresh clone, a preview build. Deferring it means the app
 * builds anywhere and a missing connection string surfaces at request time,
 * where the error is about the request rather than the bundle.
 *
 * The cache is keyed on the URL rather than just "have we built one yet". In
 * production that never matters, since the environment is fixed at boot. In dev
 * it matters a lot: correcting a wrong connection string in .env.local would
 * otherwise keep failing against the old host until you restarted the server,
 * and the error gives no hint that it is serving a stale client.
 */
function getClient(): NeonQueryFunction<false, false> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  if (client && clientUrl === url) return client;

  client = neon(url);
  clientUrl = url;
  return client;
}

/**
 * Error codes that mean the TCP connection was never established.
 *
 * This distinction carries real weight: if the connect never completed, the
 * statement provably never reached Postgres, so re-running it cannot duplicate
 * anything. That makes retrying safe even for a write like `spendCredit`.
 *
 * Deliberately excluded are mid-flight failures such as ECONNRESET and
 * UND_ERR_SOCKET. Those are ambiguous — the server may have executed the
 * statement and lost the reply on the way back — and retrying one of those
 * could charge a user twice for a single extraction.
 */
const RETRYABLE = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function isPreSendFailure(err: unknown): boolean {
  const source = (err as { sourceError?: { cause?: { code?: unknown } } })?.sourceError;
  const code = source?.cause?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" && RETRYABLE.has(code);
}

const RETRIES = 2;

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= RETRIES || !isPreSendFailure(err)) throw err;
      // Short linear backoff. These failures are transient link problems, not
      // load problems, so there is nothing to back off *from* — the delay just
      // avoids retrying into the same bad moment.
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

/**
 * Neon's HTTP driver, as a tagged template. Every interpolated value is sent as
 * a bound parameter and never spliced into the statement text.
 *
 * Each call is one HTTPS round trip, retried on connection failures that
 * demonstrably never reached the server. Note that this driver has no
 * interactive transactions — there is no BEGIN/COMMIT round trip over HTTP.
 * Where atomicity matters, the work is written as a single statement instead;
 * see `spendCredit` in src/lib/users.ts.
 */
export const sql = ((strings: TemplateStringsArray, ...params: unknown[]) =>
  withRetry(() => getClient()(strings, ...params))) as NeonQueryFunction<false, false>;

/**
 * Runs several queries in a single HTTPS round trip.
 *
 * Worth reaching for whenever a page needs more than one query. Three separate
 * `sql` calls mean three TLS handshakes, and on a long or unreliable link that
 * is three chances to time out rather than one — which is exactly how the admin
 * dashboard used to fail. Batching also makes the queries a consistent
 * snapshot, since Neon wraps them in one transaction.
 *
 *   const [a, b] = await batch((q) => [q`SELECT 1`, q`SELECT 2`]);
 */
export function batch(
  build: Parameters<NeonQueryFunction<false, false>["transaction"]>[0],
): Promise<Record<string, unknown>[][]> {
  return withRetry(() => getClient().transaction(build)) as Promise<
    Record<string, unknown>[][]
  >;
}
