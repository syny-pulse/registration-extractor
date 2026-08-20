/**
 * Naming the workbook.
 *
 * The download used to be called `registrations.xlsx` every time, which meant a
 * downloads folder full of `registrations (3).xlsx` with nothing to tell them
 * apart. The name now comes from the job: a PDF's own file name, or — for
 * photos, which have no meaningful names of their own — the event and date the
 * model read off the sheet.
 *
 * Everything here treats its input as hostile. For a photo set that name is
 * model output derived from a scanned document, so it is untrusted text on its
 * way into an HTTP header and a file system, and it is the one place in this
 * app where document content reaches either.
 */

/** Windows reserves these regardless of extension; a file so named cannot exist. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Characters no major file system will take, plus the ones that would let the
 * value break out of the quoted `filename="..."` it ends up inside.
 *
 * The C0 range matters most: a bare CR or LF in a header value is header
 * injection, and this value's ultimate source is a scanned page.
 */
const ILLEGAL = /[\u0000-\u001f\u007f<>:;"/\\|?*]/g;

/** Long enough for "Northbrook Trust AGM 2026-03-14", short of any path limit. */
const MAX_LENGTH = 80;

/** Drops the extension from a file name, keeping dots inside the stem. */
export function stemOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Reduces any candidate to something safe to write to disk, or null if nothing
 * usable survives.
 *
 * Returning null rather than a placeholder keeps the decision with the caller,
 * which is the only place that knows what a sensible fallback would be.
 */
export function sanitizeBaseName(candidate: string | null | undefined): string | null {
  if (!candidate) return null;

  const cleaned = candidate
    .replace(ILLEGAL, " ")
    // Collapse runs of whitespace, including the gaps just opened above.
    .replace(/\s+/g, " ")
    .trim()
    // Drop any segment that is nothing but dots. `../../etc/passwd` has already
    // lost its slashes above and is harmless by now, but it would still leave
    // ".. .. etc passwd" as the file name, which is a confusing thing to hand
    // someone. A dot-only segment never carries meaning here.
    .split(" ")
    .filter((segment) => !/^\.+$/.test(segment))
    .join(" ")
    // A leading or trailing dot is legal in the abstract and a nuisance in
    // practice: it hides the file on Unix and is silently stripped on Windows.
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, MAX_LENGTH)
    // Slicing can re-expose a trailing space or dot.
    .replace(/[.\s]+$/, "");

  if (!cleaned) return null;
  if (RESERVED.test(cleaned)) return null;

  return cleaned;
}

/** `registrations-2026-03-14` — distinct per day when there is nothing better. */
export function defaultBaseName(now: Date = new Date()): string {
  return `registrations-${now.toISOString().slice(0, 10)}`;
}

/**
 * Picks the workbook name for a finished job.
 *
 * A PDF is named after itself, because that is the name the user already knows
 * the document by and the one they will look for. Photos have no such name —
 * `IMG_0042.HEIC` tells nobody anything — so the model's reading of the printed
 * event and date is used instead, falling back to the date if the sheet carried
 * neither.
 */
export function workbookBaseName(job: {
  kind: "pdf" | "images";
  pdfName: string | null;
  title: string | null;
  now?: Date;
}): string {
  const candidate = job.kind === "pdf" ? stemOf(job.pdfName ?? "") : job.title;
  return sanitizeBaseName(candidate) ?? defaultBaseName(job.now);
}

/**
 * Builds the `Content-Disposition` value for a download.
 *
 * Both forms are emitted deliberately. The quoted `filename` is ASCII-only
 * because that is all RFC 6266 permits there and a non-ASCII byte in it is
 * interpreted differently by every browser; `filename*` carries the real name,
 * accents and all, and every current browser prefers it. An event name in a
 * language that is not English is the normal case here, not an edge one.
 */
export function attachmentHeader(baseName: string): string {
  const name = `${baseName}.xlsx`;

  const ascii = name.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "registrations.xlsx";

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Reads the name back out of a response header, for the browser to save under.
 *
 * The client cannot re-derive the name: for photos it was the model that
 * produced it, and only the response carries it.
 */
export function filenameFromHeader(header: string | null): string | null {
  if (!header) return null;

  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      const base = sanitizeBaseName(stemOf(decodeURIComponent(extended[1])));
      if (base) return `${base}.xlsx`;
    } catch {
      // A malformed percent-escape: fall through to the plain form below.
    }
  }

  const plain = /filename="([^"]*)"/i.exec(header);
  const base = plain ? sanitizeBaseName(stemOf(plain[1])) : null;
  return base ? `${base}.xlsx` : null;
}
