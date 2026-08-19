/**
 * The only logging entrypoint in the app.
 *
 * Vercel captures function stdout, so anything logged is retained on
 * infrastructure we have promised not to retain document content on. Rather
 * than rely on remembering that at each call site, this module accepts a fixed
 * shape that structurally cannot carry a name, a cell value, or a page.
 *
 * Do not add a free-form `message` field, and do not log `error.message`:
 * provider SDKs routinely echo request content back inside error strings, which
 * is the realistic path by which an attendee's name would end up in a log.
 * `describeError` below exists to make the safe thing the easy thing.
 */

type LogEntry = {
  event: string;
  status: "ok" | "error" | "rejected";
  userId?: string;
  pageCount?: number;
  ms?: number;
  /** A fixed code from our own vocabulary — never text from a document or SDK. */
  reason?: string;
};

export function log(entry: LogEntry): void {
  // JSON on one line so Vercel's log viewer keeps the fields queryable.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

/**
 * Reduces an unknown thrown value to a fixed, content-free label.
 *
 * Deliberately drops `error.message`. The class name plus an HTTP status is
 * enough to tell a quota problem from an auth problem from a timeout, which is
 * all a log needs to do here.
 */
export function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const name = err.constructor?.name ?? "Error";

    // ExtractionError's message is a code we assigned in src/lib/gemini.ts, not
    // free text — it is built from a fixed vocabulary plus at most an HTTP
    // status or a finish reason. Safe to log whole, and the only thing that
    // makes a failed extraction diagnosable after the fact.
    if (name === "ExtractionError") {
      return `ExtractionError:${(err as Error).message}`;
    }

    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") return `${name}:${status}`;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return `${name}:${code}`;
    return name;
  }
  return typeof err;
}
