import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  attachmentHeader,
  defaultBaseName,
  filenameFromHeader,
  sanitizeBaseName,
  stemOf,
  workbookBaseName,
} from "@/lib/filename";
import { claimedImageType, inspectUpload, sniffImageType } from "@/lib/upload";

const samples = join(process.cwd(), "samples");

function sample(name: string) {
  return new Uint8Array(readFileSync(join(samples, name)));
}

/**
 * Photo uploads.
 *
 * Everything here runs on bytes built in-process rather than on image fixtures,
 * because what is under test is the gatekeeping — which formats are let
 * through, in what order, and how many — not image decoding. Only the magic
 * number is ever read, so a valid header over zero padding is a faithful
 * stand-in for a real photograph and keeps the repo free of binary fixtures.
 */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const HEIC = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);

function imageFile(name: string, bytes: Uint8Array, type = "", padTo = 0): File {
  const body = new Uint8Array(Math.max(padTo, bytes.length));
  body.set(bytes);
  return new File([body], name, { type });
}

function pdfFile(name = "sheet.pdf"): File {
  return new File([sample("sample-sheet-2p.pdf")], name, { type: "application/pdf" });
}

const limits = { maxPages: 10, maxImages: 10, maxBytes: 4_000_000 };

describe("image format detection", () => {
  it("reads the format from the bytes, not the name", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(HEIC)).toBe("image/heic");
  });

  it("refuses bytes that are not an image at all", () => {
    expect(sniffImageType(new TextEncoder().encode("PK a zip file"))).toBeNull();
    expect(sniffImageType(sample("sample-sheet-2p.pdf"))).toBeNull();
  });

  it("recognises a photo by extension when the browser sends no MIME type", () => {
    // Files dragged in from some file managers, and HEICs straight off an
    // iPhone, arrive with an empty type. Refusing those refuses the main case.
    expect(claimedImageType({ type: "", name: "IMG_0042.HEIC" })).toBe("image/heic");
    expect(claimedImageType({ type: "", name: "sheet.JPG" })).toBe("image/jpeg");
  });

  it("normalises the JPEG type strings browsers disagree about", () => {
    expect(claimedImageType({ type: "image/jpg", name: "x" })).toBe("image/jpeg");
    expect(claimedImageType({ type: "image/pjpeg", name: "x" })).toBe("image/jpeg");
  });

  it("does not claim formats the model cannot read", () => {
    // GIF, BMP and TIFF are not accepted inline by the API. Letting one through
    // buys a slow upload and a 400 instead of an immediate, actionable refusal.
    expect(claimedImageType({ type: "image/gif", name: "sheet.gif" })).toBeNull();
    expect(claimedImageType({ type: "image/tiff", name: "scan.tiff" })).toBeNull();
    expect(claimedImageType({ type: "image/bmp", name: "scan.bmp" })).toBeNull();
  });
});

describe("upload gatekeeping", () => {
  it("accepts a set of photos and counts one page per photo", async () => {
    const result = await inspectUpload(
      [imageFile("a.jpg", JPEG), imageFile("b.png", PNG), imageFile("c.webp", WEBP)],
      limits,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("images");
    expect(result.pageCount).toBe(3);
    expect(result.sources.map((source) => source.mimeType)).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });

  it("still accepts a single PDF, reporting its real page count", async () => {
    const result = await inspectUpload([pdfFile()], limits);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("pdf");
    expect(result.pageCount).toBe(2);
    expect(result.sources[0].mimeType).toBe("application/pdf");
  });

  it("sends the type the bytes are, not the type the name claims", async () => {
    // A .png that is really a JPEG is common — phone exports, renamed files —
    // and harmless, as long as the model is told the truth about it.
    const result = await inspectUpload([imageFile("photo.png", JPEG, "image/png")], limits);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sources[0].mimeType).toBe("image/jpeg");
  });

  it("orders photos by name, so page 2 is the second sheet", async () => {
    // A file picker returns whatever order the OS listed. The workbook's Page
    // column is only useful if it maps to a predictable sheet of paper.
    const result = await inspectUpload(
      [
        imageFile("IMG_0010.jpg", JPEG),
        imageFile("IMG_0002.jpg", JPEG),
        imageFile("IMG_0001.jpg", JPEG),
      ],
      limits,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.name)).toEqual([
      "IMG_0001.jpg",
      "IMG_0002.jpg",
      "IMG_0010.jpg",
    ]);
  });

  it("orders sheet 9 before sheet 10 rather than lexically", async () => {
    const result = await inspectUpload(
      [imageFile("sheet 10.jpg", JPEG), imageFile("sheet 9.jpg", JPEG)],
      limits,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.name)).toEqual(["sheet 9.jpg", "sheet 10.jpg"]);
  });

  it("allows exactly as many photos as there are pages", async () => {
    const photos = Array.from({ length: limits.maxImages }, (_, i) =>
      imageFile(`sheet-${i}.jpg`, JPEG),
    );
    const result = await inspectUpload(photos, limits);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageCount).toBe(limits.maxImages);
  });

  it("refuses one photo more than the page limit, naming the count", async () => {
    const photos = Array.from({ length: limits.maxImages + 1 }, (_, i) =>
      imageFile(`sheet-${i}.jpg`, JPEG),
    );
    const result = await inspectUpload(photos, limits);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_many_images");
    expect(result.message).toContain(String(limits.maxImages + 1));
  });

  it("caps the total size of a photo set, not each photo separately", async () => {
    // Three 1.8 MB photos are over a 4 MB body limit while no single one of
    // them is. Checking per file would let the whole set through.
    const photos = Array.from({ length: 3 }, (_, i) =>
      imageFile(`sheet-${i}.jpg`, JPEG, "image/jpeg", 1_800_000),
    );
    const result = await inspectUpload(photos, limits);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_large");
    expect(result.message).toContain("3 files");
  });

  it("refuses a format the model cannot read, saying which are accepted", async () => {
    const result = await inspectUpload(
      [new File([new Uint8Array(10)], "notes.docx", { type: "" })],
      limits,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_type");
    expect(result.message).toContain(".docx");
    expect(result.message).toMatch(/JPEG/);
  });

  it("refuses a file whose bytes are not the image its name promises", async () => {
    const result = await inspectUpload(
      [imageFile("sheet.jpg", new TextEncoder().encode("not an image"), "image/jpeg")],
      limits,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unreadable");
  });

  it("refuses a PDF mixed in with photos, because page order becomes undefined", async () => {
    const result = await inspectUpload([pdfFile(), imageFile("a.jpg", JPEG)], limits);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("mixed_types");
  });

  it("refuses two PDFs at once, suggesting what to do instead", async () => {
    const result = await inspectUpload([pdfFile("a.pdf"), pdfFile("b.pdf")], limits);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_many_files");
    expect(result.message).toMatch(/merge/i);
  });

  it("still applies every PDF rule to a single-PDF upload", async () => {
    const overlong = new File([sample("sample-sheet-11p.pdf")], "long.pdf", {
      type: "application/pdf",
    });
    const result = await inspectUpload([overlong], limits);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_many_pages");
    expect(result.message).toContain("11 pages");
  });

  it("reports an empty selection rather than throwing", async () => {
    const result = await inspectUpload([], limits);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_file");
  });
});

describe("workbook naming", () => {
  it("names a PDF's workbook after the PDF", () => {
    expect(
      workbookBaseName({
        kind: "pdf",
        pdfName: "Youth Retreat sign-in.pdf",
        title: "ignored — a PDF already has a name the user knows it by",
      }),
    ).toBe("Youth Retreat sign-in");
  });

  it("names a photo set after the event the model read off the sheet", () => {
    expect(
      workbookBaseName({
        kind: "images",
        pdfName: null,
        title: "Northbrook Trust AGM 2026-03-14",
      }),
    ).toBe("Northbrook Trust AGM 2026-03-14");
  });

  it("falls back to a dated name when the sheet printed no event", () => {
    const now = new Date("2026-03-14T09:00:00Z");
    expect(workbookBaseName({ kind: "images", pdfName: null, title: null, now })).toBe(
      "registrations-2026-03-14",
    );
  });

  it("strips characters no file system will take", () => {
    expect(sanitizeBaseName("AGM: 14/03 <draft>")).toBe("AGM 14 03 draft");
  });

  it("refuses to build a name out of a path traversal", () => {
    // A photo's title is model output read off a scanned page, so it is
    // untrusted text on its way into a file name.
    expect(sanitizeBaseName("../../etc/passwd")).toBe("etc passwd");
    expect(sanitizeBaseName("..")).toBeNull();
  });

  it("drops a CR or LF rather than letting one reach a header", () => {
    const name = sanitizeBaseName("AGM\r\nX-Injected: yes");
    expect(name).toBe("AGM X-Injected yes");
    expect(attachmentHeader(name!)).not.toMatch(/[\r\n]/);
  });

  it("refuses names Windows reserves, which cannot exist as files", () => {
    expect(sanitizeBaseName("CON")).toBeNull();
    expect(sanitizeBaseName("nul")).toBeNull();
    expect(
      workbookBaseName({ kind: "images", pdfName: null, title: "CON", now: new Date() }),
    ).toMatch(/^registrations-/);
  });

  it("keeps a long title to something a file system will accept", () => {
    expect(sanitizeBaseName("A".repeat(300))!.length).toBeLessThanOrEqual(80);
  });

  it("keeps the extension off the stem, and dots inside it", () => {
    expect(stemOf("AGM 14.03.2026.pdf")).toBe("AGM 14.03.2026");
    expect(stemOf("no-extension")).toBe("no-extension");
  });

  it("carries a non-ASCII event name intact, with an ASCII form alongside", () => {
    // An event named in a language other than English is the normal case here,
    // not an edge one. RFC 6266 allows only ASCII in the quoted form, so the
    // real name travels in filename*, which browsers prefer.
    const header = attachmentHeader("Réunion générale 2026");
    expect(header).toContain("filename*=UTF-8''");
    expect(filenameFromHeader(header)).toBe("Réunion générale 2026.xlsx");
    expect(/filename="([^"]*)"/.exec(header)![1]).toMatch(/^[\x20-\x7e]+$/);
  });

  it("round-trips an ordinary name through the header", () => {
    expect(filenameFromHeader(attachmentHeader("Youth Retreat sign-in"))).toBe(
      "Youth Retreat sign-in.xlsx",
    );
  });

  it("gives the browser nothing rather than a bad name when there is no header", () => {
    expect(filenameFromHeader(null)).toBeNull();
    expect(filenameFromHeader("attachment")).toBeNull();
  });

  it("produces a dated default that is distinct per day", () => {
    expect(defaultBaseName(new Date("2026-08-20T23:30:00Z"))).toBe("registrations-2026-08-20");
  });
});
