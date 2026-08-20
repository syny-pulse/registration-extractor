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
 * The photo limit is the page limit: a photo of one sheet of paper is a page,
 * so ten photos and a ten-page PDF are the same amount of work and cost the
 * same single credit. Kept as an alias rather than a second env var so the two
 * cannot drift apart and leave the UI quoting one number and the server
 * enforcing another.
 */
export const MAX_IMAGES = MAX_PAGES;

/**
 * 4 MB. Vercel rejects request bodies over 4.5 MB with a bare 413 before our
 * code runs, so we cap below that and reject it ourselves with a message the
 * user can act on.
 */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 4_000_000);

/**
 * Guards against a malformed model response turning into a runaway workbook.
 *
 * The row cap was 5000 and is now double that. Photo uploads made the old
 * number reachable by an honest document rather than only by a broken one: ten
 * phone photos of a densely packed sign-in sheet carry far more rows than the
 * ten-page text PDFs this was originally sized against, and a legitimate
 * extraction failing on a guard meant for malformed output is the wrong
 * outcome. The column cap is untouched -- no registration sheet has 40 columns,
 * so a response claiming more than that is still evidence of a broken response,
 * not a big one.
 */
export const MAX_ROWS = 10_000;
export const MAX_COLUMNS = 40;

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.7-flash";

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";

/**
 * Whether the operator has confirmed the API key belongs to a **paid-tier**
 * project.
 *
 * Nothing reads this any more. /privacy used to vary its wording on it and no
 * longer does, so setting `GEMINI_PAID_TIER_CONFIRMED` currently changes
 * nothing anywhere in the app. It is kept only as the hook to wire back up if
 * the notice should ever distinguish the tiers again.
 *
 * The distinction it was built for is still real: on the free tier Google uses
 * submitted content to develop its products and human reviewers may read it; on
 * the paid tier it does neither. The key looks identical either way and no API
 * response reveals the tier, so only a person can confirm it.
 */
export const PAID_TIER_CONFIRMED = process.env.GEMINI_PAID_TIER_CONFIRMED === "true";

export type Limits = {
  maxPages: number;
  maxImages: number;
  maxUploadBytes: number;
};

export const limits: Limits = {
  maxPages: MAX_PAGES,
  maxImages: MAX_IMAGES,
  maxUploadBytes: MAX_UPLOAD_BYTES,
};
