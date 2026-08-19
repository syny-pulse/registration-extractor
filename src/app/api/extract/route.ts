import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { MAX_PAGES, MAX_UPLOAD_BYTES } from "@/lib/config";
import { extractTable } from "@/lib/gemini";
import { HttpError, requireUser } from "@/lib/guards";
import { describeError, log } from "@/lib/log";
import { inspectPdf, looksLikePdf } from "@/lib/pdf";
import { recordFailure, spendCredit } from "@/lib/users";
import { buildWorkbook } from "@/lib/xlsx";

// exceljs, pdf-lib and the Google auth library are all Node-only.
export const runtime = "nodejs";

/**
 * A ceiling, not a raise. Fluid compute gives Node functions 300s by default on
 * every plan including Hobby, so this lowers the limit to bound cost on a
 * request that has gone wrong rather than to buy more time.
 */
export const maxDuration = 120;

/** Leaves headroom under maxDuration to build the workbook and respond. */
const MODEL_TIMEOUT_MS = 100_000;

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
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      throw new HttpError(400, "no_file", "No file was uploaded.");
    }
    if (!looksLikePdf(file)) {
      throw new HttpError(400, "not_pdf", "Only PDF files can be processed.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new HttpError(
        413,
        "too_large",
        `This file is too large. The limit is ${(MAX_UPLOAD_BYTES / 1_000_000).toFixed(1)} MB — re-scan at 200 DPI in grayscale.`,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    // The browser already ran these checks to avoid a pointless upload. They
    // run again here because that pass is a convenience for the user, not a
    // control — anything can POST to this endpoint.
    const inspection = await inspectPdf(bytes, {
      maxPages: MAX_PAGES,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    if (!inspection.ok) {
      throw new HttpError(400, inspection.code, inspection.message);
    }
    pageCount = inspection.pageCount;

    // ---- 3. Extract ---------------------------------------------------------
    // From here on a failure is chargeable-looking but must not be charged, so
    // everything below is wrapped to record the attempt without spending a
    // credit.
    let workbook: Buffer;
    let unclearCount: number;

    try {
      const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
      const result = await extractTable(bytes, timeout);
      unclearCount = result.unclearCount;
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
      return NextResponse.json(
        {
          error:
            "The document could not be processed. Your credit has not been used — please try again.",
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
        "Content-Disposition": 'attachment; filename="registrations.xlsx"',
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
