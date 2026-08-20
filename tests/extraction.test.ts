import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";

import { MAX_COLUMNS, MAX_ROWS } from "@/lib/config";
import { ExtractionError, normalize } from "@/lib/gemini";
import { describeError } from "@/lib/log";
import { inspectPdf, looksLikePdf } from "@/lib/pdf";
import { extractionSchema } from "@/lib/validation";
import { buildWorkbook } from "@/lib/xlsx";

const samples = join(process.cwd(), "samples");
const limits = { maxPages: 10, maxBytes: 4_000_000 };

function sample(name: string) {
  return new Uint8Array(readFileSync(join(samples, name)));
}

/**
 * exceljs ships `declare interface Buffer extends ArrayBuffer {}`, which merges
 * into the *global* Buffer and then disagrees with Node's generic
 * `Buffer<ArrayBufferLike>`. Both are the same object at runtime. Reading a
 * workbook back is how these tests assert anything, so the cast lives here once
 * rather than at four call sites.
 */
async function readBack(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook.getWorksheet("Registrations")!;
}

describe("PDF gatekeeping", () => {
  it("accepts a document inside the limits and reports its page count", async () => {
    const result = await inspectPdf(sample("sample-sheet-2p.pdf"), limits);
    expect(result).toEqual({ ok: true, pageCount: 2 });
  });

  it("refuses a document over the page limit, naming the actual count", async () => {
    const result = await inspectPdf(sample("sample-sheet-11p.pdf"), limits);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_many_pages");
    expect(result.message).toContain("11 pages");
  });

  it("refuses an oversized file before it tries to parse it", async () => {
    const result = await inspectPdf(sample("sample-sheet-2p.pdf"), {
      ...limits,
      maxBytes: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_large");
    // The message has to be actionable, not just a refusal.
    expect(result.message).toContain("200 DPI");
  });

  it("reports damaged input as unreadable rather than throwing", async () => {
    const result = await inspectPdf(new TextEncoder().encode("not a pdf"), limits);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unreadable");
  });

  it("recognises PDFs by extension when the browser sends no MIME type", () => {
    expect(looksLikePdf({ type: "", name: "scan.PDF" })).toBe(true);
    expect(looksLikePdf({ type: "image/png", name: "scan.png" })).toBe(false);
  });
});

/**
 * Builds an encrypted PDF in memory.
 *
 * Passing only an `ownerPassword` produces the permissions-only shape that
 * scanners and office suites emit constantly: an /Encrypt dictionary carrying
 * permission flags, with an empty user password, opening in any reader without
 * a prompt. Passing a `userPassword` produces a document that genuinely cannot
 * be opened without one.
 */
async function encryptedPdf(opts: {
  pages?: number;
  ownerPassword?: string;
  userPassword?: string;
  algorithm?: "RC4-40" | "RC4-128" | "AES-128" | "AES-256";
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < (opts.pages ?? 3); i += 1) {
    doc
      .addPage([595, 842])
      .drawText(`Attendance register, sheet ${i + 1}`, {
        x: 40,
        y: 780,
        size: 12,
        font,
      });
  }

  doc.encrypt({
    ownerPassword: opts.ownerPassword,
    userPassword: opts.userPassword,
    algorithm: opts.algorithm ?? "AES-256",
    // RC4 is refused by default as broken, but it is what older scanners emit,
    // so it has to be exercised here.
    allowWeakCryptography: true,
    permissions: { printing: "highResolution", copying: false, modifying: false },
  });

  return doc.save();
}

/**
 * Regression cover for documents rejected as password-protected when they were
 * nothing of the kind.
 *
 * The check used to reject on `isEncrypted`, which is true whenever a PDF
 * carries an /Encrypt dictionary at all — including the very common case of
 * permissions-only encryption with no user password. This path previously had
 * no tests, which is precisely why that shipped.
 */
describe("encrypted PDFs", () => {
  const ciphers = ["RC4-40", "RC4-128", "AES-128", "AES-256"] as const;

  for (const algorithm of ciphers) {
    it(`accepts a permissions-only document (${algorithm})`, async () => {
      const bytes = await encryptedPdf({ ownerPassword: "owner-secret", algorithm });
      const result = await inspectPdf(bytes, limits);
      expect(result).toEqual({ ok: true, pageCount: 3 });
    });
  }

  // RC4-40 cannot carry a user password in this library's handler, so the
  // genuinely-protected cases cover the three that can.
  for (const algorithm of ["RC4-128", "AES-128", "AES-256"] as const) {
    it(`still refuses a document that needs a password (${algorithm})`, async () => {
      const bytes = await encryptedPdf({
        ownerPassword: "owner-secret",
        userPassword: "letmein",
        algorithm,
      });
      const result = await inspectPdf(bytes, limits);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("encrypted");
      expect(result.message).toMatch(/needs a password/i);
    });
  }

  it("still enforces the page limit on an encrypted document", async () => {
    // Encryption must not become a way around the page cap.
    const bytes = await encryptedPdf({ pages: 11, ownerPassword: "owner-secret" });
    const result = await inspectPdf(bytes, limits);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_many_pages");
    expect(result.message).toContain("11 pages");
  });

  it("still enforces the size limit on an encrypted document", async () => {
    const bytes = await encryptedPdf({ ownerPassword: "owner-secret" });
    const result = await inspectPdf(bytes, { ...limits, maxBytes: 100 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_large");
  });
});

describe("model response normalization", () => {
  it("pads a short row out to the column width", () => {
    const { extraction } = normalize({
      columns: ["Name", "Organisation", "Email"],
      rows: [{ page: 1, values: ["Ada Lovelace"] }],
    });
    expect(extraction.rows[0].values).toEqual(["Ada Lovelace", "", ""]);
  });

  it("truncates a row that claims more values than there are columns", () => {
    const { extraction } = normalize({
      columns: ["Name"],
      rows: [{ page: 1, values: ["Ada", "stray", "values"] }],
    });
    expect(extraction.rows[0].values).toEqual(["Ada"]);
  });

  it("counts UNCLEAR cells across every row", () => {
    const { unclearCount } = normalize({
      columns: ["Name", "Signature"],
      rows: [
        { page: 1, values: ["UNCLEAR", "UNCLEAR"] },
        { page: 2, values: ["Grace Hopper", "  UNCLEAR  "] },
      ],
    });
    expect(unclearCount).toBe(3);
  });

  it("accepts a response right at the row cap", () => {
    // The cap was doubled when photo uploads made it reachable by an honest
    // document. Pinning the boundary from the constant keeps this test honest
    // if it moves again.
    const { extraction } = normalize({
      columns: ["Name"],
      rows: Array.from({ length: MAX_ROWS }, () => ({ page: 1, values: ["x"] })),
    });
    expect(extraction.rows).toHaveLength(MAX_ROWS);
  });

  it("refuses an implausible number of rows instead of building the workbook", () => {
    expect(() =>
      normalize({
        columns: ["Name"],
        rows: Array.from({ length: MAX_ROWS + 1 }, () => ({ page: 1, values: ["x"] })),
      }),
    ).toThrow(ExtractionError);
  });

  it("refuses an implausible number of columns", () => {
    expect(() =>
      normalize({
        columns: Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `c${i}`),
        rows: [],
      }),
    ).toThrow(ExtractionError);
  });

  it("carries the sheet's own event label through as the workbook title", () => {
    const { title } = normalize({
      title: "  Northbrook Trust AGM 2026-03-14  ",
      columns: ["Name"],
      rows: [],
    });
    expect(title).toBe("Northbrook Trust AGM 2026-03-14");
  });

  it("treats a missing, empty or UNCLEAR title as no title at all", () => {
    // UNCLEAR is the model's answer for anything it cannot read, headings
    // included. A file called UNCLEAR.xlsx would be an absurd outcome.
    expect(normalize({ columns: ["Name"], rows: [] }).title).toBeNull();
    expect(normalize({ title: "   ", columns: ["Name"], rows: [] }).title).toBeNull();
    expect(normalize({ title: "UNCLEAR", columns: ["Name"], rows: [] }).title).toBeNull();
  });
});

describe("response schema", () => {
  it("rejects a response with no columns", () => {
    expect(extractionSchema.safeParse({ columns: [], rows: [] }).success).toBe(false);
  });

  it("rejects a row whose page number is not a positive integer", () => {
    const parsed = extractionSchema.safeParse({
      columns: ["Name"],
      rows: [{ page: 0, values: ["Ada"] }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("workbook", () => {
  const extraction = {
    columns: ["Name", "Organisation", "Email", "Time in"],
    rows: [
      {
        page: 1,
        values: ["Priya Raghunathan", "Northbrook Trust", "priya.r@example.org", "09:05"],
      },
      { page: 1, values: ["UNCLEAR", "Vellum & Co", "t.eriksson@example.com", "09:11"] },
      { page: 2, values: ["Amara Okonkwo", "", "UNCLEAR", "09:14"] },
    ],
  };

  it("produces a readable xlsx carrying the sheet's own columns", async () => {
    const buffer = await buildWorkbook(extraction);
    expect(buffer[0]).toBe(0x50); // "PK" — a zip container, as xlsx must be
    expect(buffer[1]).toBe(0x4b);

    const sheet = await readBack(buffer);

    expect(sheet.getRow(1).values).toEqual([
      undefined,
      "Page",
      "Name",
      "Organisation",
      "Email",
      "Time in",
    ]);
    expect(sheet.rowCount).toBe(4); // header + 3 data rows
  });

  it("keeps the page number so an UNCLEAR cell can be traced to the paper", async () => {
    const sheet = await readBack(await buildWorkbook(extraction));
    expect(sheet.getRow(4).getCell(1).value).toBe(2);
  });

  it("marks UNCLEAR cells with weight, not colour", async () => {
    const sheet = await readBack(await buildWorkbook(extraction));

    expect(sheet.getRow(3).getCell(2).font?.bold).toBe(true); // the UNCLEAR name
    expect(sheet.getRow(2).getCell(2).font?.bold).toBeFalsy(); // an ordinary name
    expect(sheet.getRow(3).getCell(2).font?.color).toBeUndefined();
  });

  it("freezes the header row and marks it bold", async () => {
    const sheet = await readBack(await buildWorkbook(extraction));
    expect(sheet.getRow(1).font?.bold).toBe(true);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });
});

describe("failure reporting", () => {
  it("logs an ExtractionError's code, so a failure is diagnosable", () => {
    const err = new ExtractionError("api_error", "Quota exhausted.", "429");
    expect(describeError(err)).toBe("ExtractionError:api_error:429");
  });

  it("still says something useful when there is no detail to add", () => {
    const err = new ExtractionError("no_api_key", "No key configured.");
    expect(describeError(err)).toBe("ExtractionError:no_api_key");
  });

  it("keeps the user-facing message separate from the logged code", () => {
    const err = new ExtractionError("timeout", "The document took too long to read.");
    // The log gets the code; the human gets the sentence. Neither carries
    // anything from the document.
    expect(describeError(err)).not.toContain("took too long");
    expect(err.userMessage).toContain("took too long");
  });

  it("refuses an implausible row count with a code, not a bare Error", () => {
    try {
      normalize({
        columns: ["Name"],
        rows: Array.from({ length: MAX_ROWS + 1 }, () => ({ page: 1, values: ["x"] })),
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractionError);
      expect((err as ExtractionError).code).toBe("too_large_result");
      expect(describeError(err)).toBe("ExtractionError:too_large_result:rows");
    }
  });
});

describe("log redaction", () => {
  it("drops the error message, which is where document content leaks", () => {
    const err = Object.assign(
      new Error("Invalid content: attendee Priya Raghunathan, priya.r@example.org"),
      { status: 400 },
    );
    const label = describeError(err);
    expect(label).toBe("Error:400");
    expect(label).not.toContain("Priya");
    expect(label).not.toContain("example.org");
  });

  it("keeps a machine code when there is no HTTP status", () => {
    expect(describeError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(
      "Error:ECONNRESET",
    );
  });

  it("never returns free-form text for an unrecognised throw", () => {
    expect(describeError("a raw string containing Priya Raghunathan")).toBe("string");
  });
});
