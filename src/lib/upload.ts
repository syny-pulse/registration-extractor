/**
 * What may be uploaded, in one place, shared by the browser and the server.
 *
 * There are exactly two shapes of job: one PDF, or a set of photos. They are
 * deliberately not mixable — a job has one page ordering, and interleaving a
 * PDF's pages with loose photos has no defensible answer for what page 3 is.
 *
 * As with ./pdf, the browser runs this to avoid a pointless upload and the
 * server runs the identical checks on the bytes it actually received. Anything
 * can POST to /api/extract, so nothing here is a control until the server
 * repeats it.
 */

import { formatMb, inspectPdf, looksLikePdf } from "./pdf";

/**
 * The image formats Gemini accepts inline, mapped to the extensions people
 * actually have on disk.
 *
 * This is the provider's list, not a preference: JPEG, PNG, WebP and the HEIC
 * pair are what the API decodes. GIF, BMP and TIFF are excluded because they
 * are not accepted — sending one produces a 400 from the model after a full
 * upload, which is a far worse experience than refusing it here with a sentence
 * saying what to do instead.
 */
export const IMAGE_TYPES: Record<string, readonly string[]> = {
  "image/jpeg": [".jpg", ".jpeg", ".jpe", ".jfif"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/heic": [".heic"],
  "image/heif": [".heif"],
};

/** For the file input's `accept` attribute and the "unsupported format" copy. */
export const ACCEPTED_IMAGE_EXTENSIONS = Object.values(IMAGE_TYPES).flat();

export const UPLOAD_ACCEPT_ATTRIBUTE = [
  "application/pdf",
  ".pdf",
  ...Object.keys(IMAGE_TYPES),
  ...ACCEPTED_IMAGE_EXTENSIONS,
].join(",");

/** Browsers and phones disagree on the JPEG type string; normalise the strays. */
const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/heic-sequence": "image/heic",
  "image/heif-sequence": "image/heif",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * The image type a file claims to be, by MIME type or by extension.
 *
 * Extension is a real fallback rather than a nicety: files dragged in from some
 * file managers, and HEICs straight off an iPhone, arrive with an empty `type`.
 * This is only a claim — sniffImageType below checks the bytes.
 */
export function claimedImageType(file: { type: string; name: string }): string | null {
  const declared = MIME_ALIASES[file.type.toLowerCase()] ?? file.type.toLowerCase();
  if (declared in IMAGE_TYPES) return declared;

  const extension = extensionOf(file.name);
  for (const [mime, extensions] of Object.entries(IMAGE_TYPES)) {
    if (extensions.includes(extension)) return mime;
  }
  return null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, i) => bytes[i] === byte);
}

/**
 * The image type the bytes actually are, read from the file's magic number.
 *
 * The declared type is whatever the browser guessed from the extension, so a
 * `.png` that is really a JPEG is common and harmless — but a `.png` that is
 * really a Word document is not, and would otherwise be discovered only by the
 * model rejecting it after a full upload and a slow request. Sniffing also
 * settles which type to *send*: what the bytes are beats what the name says.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  // JPEG: SOI marker.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // PNG: the 8-byte signature, including the CRLF/EOF corruption detectors.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  // RIFF container; bytes 8-11 name the form type.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }

  // ISO base media: an `ftyp` box at offset 4, whose brand distinguishes the
  // HEIC and HEIF flavours an iPhone produces. `mif1`/`msf1` are the generic
  // HEIF brands; the `hei*`/`hev*` brands are HEIC.
  if (startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70])) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (/^(heic|heix|hevc|hevx)$/.test(brand)) return "image/heic";
    if (/^(mif1|msf1|heim|heis|hevm|hevs)$/.test(brand)) return "image/heif";
  }

  return null;
}

export type UploadRejection = {
  ok: false;
  code:
    | "no_file"
    | "mixed_types"
    | "unsupported_type"
    | "too_many_files"
    | "too_many_images"
    | "too_large"
    | "unreadable"
    | "not_pdf"
    | "encrypted"
    | "too_many_pages";
  message: string;
};

/** One entry per source page, in the order the model will be shown them. */
export type UploadSource = { bytes: Uint8Array; mimeType: string };

export type UploadAccepted = {
  ok: true;
  /** Which of the two job shapes this is — decides how the workbook is named. */
  kind: "pdf" | "images";
  /** Pages for a PDF, photos for an image set. One credit either way. */
  pageCount: number;
  /**
   * The accepted files, in page order.
   *
   * Handed back so the browser can list them in the order they will be read and
   * upload them in that same order, rather than re-deriving an ordering that
   * might not match the one applied here.
   */
  files: File[];
  sources: UploadSource[];
};

export type UploadInspection = UploadAccepted | UploadRejection;

export type UploadLimits = {
  maxPages: number;
  maxImages: number;
  maxBytes: number;
};

function reject(code: UploadRejection["code"], message: string): UploadRejection {
  return { ok: false, code, message };
}

/**
 * Validates a selection and returns exactly what the model should be sent.
 *
 * Reading every file into memory here is the point rather than a cost: the
 * bytes have to be read to be checked at all, and handing them back means the
 * server never re-reads a `File` it has already validated, so there is no
 * window in which the checked bytes and the sent bytes could differ.
 */
export async function inspectUpload(
  files: File[],
  limits: UploadLimits,
): Promise<UploadInspection> {
  if (files.length === 0) {
    return reject("no_file", "No file was uploaded.");
  }

  const pdfs = files.filter((file) => looksLikePdf(file));
  const images = files.filter((file) => !looksLikePdf(file) && claimedImageType(file));
  const unsupported = files.filter(
    (file) => !looksLikePdf(file) && !claimedImageType(file),
  );

  if (unsupported.length > 0) {
    const extension = extensionOf(unsupported[0].name);
    return reject(
      "unsupported_type",
      `${extension ? extension : "That file"} cannot be processed. ` +
        "Upload a PDF, or photos as JPEG, PNG, WebP or HEIC.",
    );
  }

  if (pdfs.length > 0 && images.length > 0) {
    return reject(
      "mixed_types",
      "Upload either one PDF or a set of photos, not both at once. " +
        "Mixing them leaves no reliable page order.",
    );
  }

  if (pdfs.length > 1) {
    return reject(
      "too_many_files",
      `Upload one PDF at a time. To combine ${pdfs.length} documents, merge them ` +
        "into a single PDF first, or photograph the sheets instead.",
    );
  }

  // The whole selection travels as one request body, so the cap is on the
  // total. Checking each file separately would let ten 3 MB photos through a
  // 4 MB limit.
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > limits.maxBytes) {
    return reject(
      "too_large",
      files.length === 1
        ? `This file is ${formatMb(total)}. The limit is ${formatMb(limits.maxBytes)}. ` +
            "Re-scan at 200 DPI in grayscale — that is plenty for handwriting and " +
            "usually lands around 300 KB per page."
        : `These ${files.length} files come to ${formatMb(total)} together, over the ` +
            `${formatMb(limits.maxBytes)} limit for one upload. Photos are normally ` +
            "shrunk in your browser to fit; HEIC files are the exception, because most " +
            "browsers cannot open one. Save them as JPEG, or send fewer at a time.",
    );
  }

  if (pdfs.length === 1) {
    const file = pdfs[0];
    const bytes = new Uint8Array(await file.arrayBuffer());

    const inspection = await inspectPdf(bytes, {
      maxPages: limits.maxPages,
      maxBytes: limits.maxBytes,
    });
    if (!inspection.ok) return reject(inspection.code, inspection.message);

    return {
      ok: true,
      kind: "pdf",
      pageCount: inspection.pageCount,
      files: [file],
      sources: [{ bytes, mimeType: "application/pdf" }],
    };
  }

  if (images.length > limits.maxImages) {
    return reject(
      "too_many_images",
      `You selected ${images.length} photos. The limit is ${limits.maxImages} — ` +
        "one per sheet of paper. Upload them in smaller batches.",
    );
  }

  // Photos arrive from a file picker in whatever order the OS listed them, which
  // is not necessarily the order they were taken. Sorting by name is what makes
  // IMG_0041 page 1 and IMG_0042 page 2 — the order a phone camera produces and
  // the order someone photographing sheets in sequence expects. `numeric` keeps
  // "sheet 9" ahead of "sheet 10".
  const ordered = [...images].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );

  const sources: UploadSource[] = [];
  for (const file of ordered) {
    const bytes = new Uint8Array(await file.arrayBuffer());

    // What the bytes are beats what the name claims. A file that is not an
    // image at all is caught here rather than by the model, after the upload.
    const mimeType = sniffImageType(bytes);
    if (!mimeType) {
      return reject(
        "unreadable",
        `"${file.name}" could not be read as an image. It may be damaged, or it ` +
          "may not be the format its name suggests.",
      );
    }

    sources.push({ bytes, mimeType });
  }

  return { ok: true, kind: "images", pageCount: sources.length, files: ordered, sources };
}
