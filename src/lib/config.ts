/**
 * Limits, resolved once. Shared between the client (which enforces them early
 * to avoid a pointless upload) and the server (which enforces them for real).
 *
 * MAX_PAGES / MAX_UPLOAD_BYTES are read through NEXT_PUBLIC_-free env vars on
 * the server and mirrored to the client via props, so a user editing their own
 * bundle changes nothing that matters.
 */

export const MAX_PAGES = Number(process.env.MAX_PAGES ?? 10);

/**
 * 4 MB. Vercel rejects request bodies over 4.5 MB with a bare 413 before our
 * code runs, so we cap below that and reject it ourselves with a message the
 * user can act on.
 */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 4_000_000);

/** Guards against a malformed model response turning into a runaway workbook. */
export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 40;

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.7-flash";

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";

/**
 * Whether the operator has confirmed the API key belongs to a **paid-tier**
 * project.
 *
 * This matters more than it looks. On the free tier Google uses submitted
 * content to develop its products and human reviewers may read it; on the paid
 * tier it does neither. The key itself looks identical either way, and nothing
 * in the API response reveals which tier you are on — so code cannot check
 * this, and the privacy notice must not claim paid-tier terms until a person
 * has confirmed them.
 *
 * Defaults to false so the cautious text is what ships.
 */
export const PAID_TIER_CONFIRMED = process.env.GEMINI_PAID_TIER_CONFIRMED === "true";

export type Limits = {
  maxPages: number;
  maxUploadBytes: number;
};

export const limits: Limits = {
  maxPages: MAX_PAGES,
  maxUploadBytes: MAX_UPLOAD_BYTES,
};
