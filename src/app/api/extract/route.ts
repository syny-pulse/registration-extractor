import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { MAX_IMAGES, MAX_PAGES, MAX_UPLOAD_BYTES } from "@/lib/config";
import { attachmentHeader, workbookBaseName } from "@/lib/filename";
import { ExtractionError, extractTable } from "@/lib/gemini";
import { HttpError, requireUser } from "@/lib/guards";
import { describeError, log } from "@/lib/log";
import { inspectUpload } from "@/lib/upload";
import { recordFailure, spendCredit } from "@/lib/users";
import { buildWorkbook } from "@/lib/xlsx";

// exceljs, pdf-lib and the Google auth library are all Node-only.
export const runtime = "nodejs";

/**
 * The platform maximum on Hobby, and the default everywhere with Fluid compute.
 *
 * This was 120s, chosen to bound cost. That was the wrong instinct: billing is
 * on *active CPU*, and a request spent waiting on the model burns almost none —
 * so a generous ceiling costs nearly nothing, while a tight one turns a slow
 * document into a failed extraction. Scanned images are far slower to read than
 * the text PDFs used in testing, which is exactly the case that needs the room.
 */
export const maxDuration = 300;

/** Leaves headroom under maxDuration to build the workbook and respond. */
const MODEL_TIMEOUT_MS = 260_000;

export async function POST(request: Request) {
  const startedAt = Date.now();
  let userId: string | undefined;
  let pageCount = 0;

  try {
    // ---- 1. Who is asking, and may they? -----------------------------------
    const user = await requireUser();
    userId = user.id;

    if (user.credits < 1) {
      throw new HttpError(
        402,
        "no_credits",
        "You have no extraction credits left. Ask an administrator to top up your account.",
      );
    }

    // ---- 2. What did they send? --------------------------------------------
    // One PDF, or up to MAX_IMAGES photos, under the same field name. getAll
    // covers both: a single-file selection is just a list of one.
    const form = await request.formData();
    const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);

    // The browser already ran these checks to avoid a pointless upload. They
    // run again here because that pass is a convenience for the user, not a
    // control — anything can POST to this endpoint.
    const inspection = await inspectUpload(files, {
      maxPages: MAX_PAGES,
      maxImages: MAX_IMAGES,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    if (!inspection.ok) {
      // A body over the limit is the one rejection with a status of its own;
      // everything else here is a malformed request.
      const status = inspection.code === "too_large" ? 413 : 400;
      throw new HttpError(status, inspection.code, inspection.message);
    }
    pageCount = inspection.pageCount;

    // ---- 3. Extract ---------------------------------------------------------
    // From here on a failure is chargeable-looking but must not be charged, so
    // everything below is wrapped to record the attempt without spending a
    // credit.
    let workbook: Buffer;
    let unclearCount: number;
    let baseName: string;

    try {
      const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
      const result = await extractTable(inspection.sources, timeout);
      unclearCount = result.unclearCount;

      // A PDF is named after itself; a set of photos is named after the event
      // and date the model read off the sheet, because IMG_0042.HEIC is not a
      // name anyone can find a file by later.
      baseName = workbookBaseName({
        kind: inspection.kind,
        pdfName: inspection.files[0]?.name ?? null,
        title: result.title,
      });

      workbook = await buildWorkbook(result.extraction);
    } catch (err) {
      await recordFailure(user.id, pageCount).catch(() => {});
      log({
        event: "extract",
        status: "error",
        userId: user.id,
        pageCount,
        ms: Date.now() - startedAt,
        reason: describeError(err),
      });

      // Say what actually went wrong where we know it. A blanket "please try
      // again" is wrong for a missing API key or an exhausted quota — retrying
      // those forever will never work, and the person hitting it has no way to
      // tell that from a transient blip.
      const known = err instanceof ExtractionError ? err : null;
      return NextResponse.json(
        {
          error:
            (known?.userMessage ?? "The document could not be processed. Please try again.") +
            " Your credit has not been used.",
          code: known?.code ?? "unknown",
        },
        { status: 502 },
      );
    }

    // ---- 4. Charge, and record ---------------------------------------------
    // One statement: the credit comes off and the usage row lands together, or
    // neither happens. See spendCredit() for why this is not a transaction.
    const remaining = await spendCredit(user.id, pageCount);

    log({
      event: "extract",
      status: "ok",
      userId: user.id,
      pageCount,
      ms: Date.now() - startedAt,
    });

    // ---- 5. Hand it over ----------------------------------------------------
    // The only copy of this data is now travelling to the user's download
    // folder. Nothing was written to disk, to Blob storage, or to the database.
    return new NextResponse(new Uint8Array(workbook), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": attachmentHeader(baseName),
        "Content-Length": String(workbook.byteLength),
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        // Read by the client to show the summary line. Counts only — no content.
        "X-Unclear-Count": String(unclearCount),
        "X-Page-Count": String(pageCount),
        "X-Credits-Remaining": remaining === null ? "0" : String(remaining),
      },
    });
  } catch (err) {
    return errorResponse("extract", err, userId);
  }
}
