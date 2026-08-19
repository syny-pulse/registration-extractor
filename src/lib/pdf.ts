/**
 * PDF inspection, shared by the browser and the server.
 *
 * The browser runs this before uploading so an oversized or over-long document
 * is rejected in milliseconds instead of after a slow upload. The server runs
 * exactly the same checks again on the bytes it actually received, because the
 * client-side pass is a convenience and nothing more — anything can POST to
 * /api/extract.
 */

export type PdfRejection =
  | { ok: false; code: "not_pdf"; message: string }
  | { ok: false; code: "too_large"; message: string }
  | { ok: false; code: "encrypted"; message: string }
  | { ok: false; code: "unreadable"; message: string }
  | { ok: false; code: "too_many_pages"; message: string };

export type PdfInspection = { ok: true; pageCount: number } | PdfRejection;

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Errors from the library's decryption path meaning a real password is needed.
 *
 * Matched on message text because these are plain `Error`s with nothing to
 * switch on. That is brittle by nature, so tests build genuinely
 * password-protected PDFs and assert this still fires — if an upgrade rewords
 * them, the suite fails rather than the app silently accepting documents it
 * cannot read.
 */
const NEEDS_PASSWORD = /NEEDS PASSWORD|Password incorrect/i;

/**
 * Counts pages and screens out documents that cannot be processed.
 *
 * `@cantoo/pdf-lib` is loaded through a dynamic import so that the browser
 * bundle only pays for it once someone actually picks a file — it is a few
 * hundred KB and has no business in the initial page load.
 */
export async function inspectPdf(
  bytes: ArrayBuffer | Uint8Array,
  opts: { maxPages: number; maxBytes: number },
): Promise<PdfInspection> {
  const size = bytes.byteLength;

  if (size > opts.maxBytes) {
    return {
      ok: false,
      code: "too_large",
      message:
        `This file is ${formatMb(size)}. The limit is ${formatMb(opts.maxBytes)}. ` +
        `Re-scan at 200 DPI in grayscale — that is plenty for handwriting and ` +
        `usually lands around 300 KB per page.`,
    };
  }

  const { PDFDocument } = await import("@cantoo/pdf-lib");

  let doc;
  try {
    // Opening with an empty password is what separates the two cases that
    // matter. A great many perfectly ordinary PDFs — scanner output especially —
    // carry an /Encrypt dictionary purely to hold permission flags like "no
    // copying", with no user password at all; those open here silently. Only a
    // document that genuinely demands a password throws.
    //
    // Testing `isEncrypted` instead, as this once did, conflates the two and
    // rejects every permissions-only document. It is set by the mere presence of
    // an /Encrypt dictionary and says nothing about whether the file can be
    // opened. There is no need to consult it below: a successful load here has
    // already cleared it.
    doc = await PDFDocument.load(bytes, { password: "", updateMetadata: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (NEEDS_PASSWORD.test(message)) {
      return {
        ok: false,
        code: "encrypted",
        message:
          "This PDF needs a password to open. Open it in a PDF reader, save an " +
          "unprotected copy, and upload that instead.",
      };
    }

    // Some other failure: encryption we cannot evaluate (a missing /ID array, a
    // non-Standard /Filter, an unsupported /V), or a damaged file. Try once more
    // reading structure only.
    //
    // Deliberately permissive, because the model handles encrypted input fine.
    // Wrongly letting one through costs a single failed extraction that charges
    // no credit; wrongly blocking one is the defect this replaced.
    try {
      doc = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
    } catch {
      return {
        ok: false,
        code: "unreadable",
        message: "This file could not be read as a PDF. It may be damaged.",
      };
    }
  }

  // Encryption covers strings and streams, never the numbers and names the page
  // tree is built from — so this is reliable even on a document we could not
  // decrypt above, and the page limit cannot be evaded by encrypting a file.
  const pageCount = doc.getPageCount();

  if (pageCount === 0) {
    return { ok: false, code: "unreadable", message: "This PDF has no pages." };
  }

  if (pageCount > opts.maxPages) {
    return {
      ok: false,
      code: "too_many_pages",
      message:
        `This document has ${pageCount} pages. The limit is ${opts.maxPages}. ` +
        `Split it and upload the parts separately.`,
    };
  }

  return { ok: true, pageCount };
}

/** Cheap first pass so an obviously wrong file never reaches the parser. */
export function looksLikePdf(file: { type: string; name: string }): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}
