/**
 * Shrinking photos in the browser, before they are uploaded.
 *
 * Browser-only: everything here needs a canvas.
 *
 * This exists because the two limits are otherwise irreconcilable. Vercel
 * rejects request bodies over 4.5 MB before any of our code runs, so the whole
 * upload has to fit in about 4 MB — while a photo off a current phone is 2 to
 * 5 MB on its own. Ten photos of ten sheets is the case the feature is for, and
 * without this it would be flatly impossible: the user would be told to send
 * two photos at a time, forever.
 *
 * A scan at 200 DPI is the quality bar the rest of the app is written around,
 * and 2200px down the long edge of an A4 sheet is a shade under 190 DPI. So the
 * target here is not "small enough to squeak through" — it is the same
 * resolution the PDF path already treats as plenty for handwriting.
 *
 * Re-encoding also drops the EXIF block, which on a phone photo carries the GPS
 * coordinates of wherever the sheet was photographed. Nothing downstream wanted
 * that, and this is the last point at which it can be removed rather than sent
 * to Google. Orientation is read out of EXIF first and baked into the pixels,
 * so a portrait photo does not arrive on its side.
 */

import { claimedImageType } from "./upload";

/** ~190 DPI across an A4 sheet — the resolution the PDF guidance already assumes. */
const MAX_LONG_EDGE = 2200;

/** Tried in order, stopping at the first result inside the budget. */
const ATTEMPTS: Array<{ longEdge: number; quality: number }> = [
  { longEdge: MAX_LONG_EDGE, quality: 0.85 },
  { longEdge: MAX_LONG_EDGE, quality: 0.7 },
  { longEdge: MAX_LONG_EDGE, quality: 0.55 },
  // Only reached by a photo that is still too big at low quality — a very large
  // sensor, or a sheet photographed alongside half a room. Losing resolution is
  // the last resort, after quality.
  { longEdge: 1600, quality: 0.7 },
];

/** Leaves room for the multipart framing and the other files' rounding. */
const BUDGET_FRACTION = 0.9;

function canvasFor(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function toJpeg(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))),
        "image/jpeg",
        quality,
      );
    });
  }
  return canvas.convertToBlob({ type: "image/jpeg", quality });
}

function renamed(original: string): string {
  const dot = original.lastIndexOf(".");
  // The stem is kept because photo order is decided by name — IMG_0041 has to
  // stay ahead of IMG_0042 once these reach the server.
  return `${dot > 0 ? original.slice(0, dot) : original}.jpg`;
}

/**
 * Re-encodes one photo to fit `budgetBytes`, or returns null if it cannot.
 *
 * Returning null rather than throwing is deliberate: every failure here is
 * recoverable by sending the original and letting the size check refuse it with
 * a sentence the user can act on. The realistic failure is a HEIC in a browser
 * that will not decode one — Chrome and Firefox both refuse, so an iPhone photo
 * uploaded from a desktop lands here.
 */
async function shrinkOne(file: File, budgetBytes: number): Promise<File | null> {
  let bitmap: ImageBitmap;
  try {
    // `from-image` applies the EXIF orientation to the pixels. Without it a
    // portrait photo is decoded in landscape and the model reads it sideways.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }

  try {
    let best: Blob | null = null;

    for (const attempt of ATTEMPTS) {
      const scale = Math.min(1, attempt.longEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = canvasFor(width, height);
      const context = canvas.getContext("2d") as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!context) return null;

      // A sheet of paper is mostly white; without this the transparent areas of
      // an alpha-carrying source turn black under JPEG.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, width, height);

      let blob: Blob;
      try {
        blob = await toJpeg(canvas, attempt.quality);
      } catch {
        return null;
      }

      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= budgetBytes) break;
    }

    if (!best) return null;

    return new File([best], renamed(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

/**
 * Shrinks whatever in the selection is a photo and needs it.
 *
 * PDFs pass through untouched — they are re-encoded by nobody, and a PDF over
 * the cap is a scanning-settings problem the existing message already explains.
 * A photo already inside its share of the budget is left alone too: re-encoding
 * it would only throw away detail to no purpose.
 *
 * Nothing here can fail the upload. A file that cannot be decoded is handed back
 * exactly as it came in, and the size check downstream refuses it — or does not
 * — on its own merits.
 */
export async function shrinkPhotos(files: File[], maxTotalBytes: number): Promise<File[]> {
  // The same classification the validation uses, so a HEIC with an empty `type`
  // — which is how one arrives off an iPhone — is treated as the photo it is.
  const isPhoto = (file: File) => claimedImageType(file) !== null;

  const photos = files.filter(isPhoto);
  if (photos.length === 0) return files;

  const budget = Math.floor((maxTotalBytes * BUDGET_FRACTION) / photos.length);

  return Promise.all(
    files.map(async (file) => {
      if (!isPhoto(file)) return file;
      if (file.size <= budget) return file;

      const shrunk = await shrinkOne(file, budget);
      // Only take the result if it actually helped. A small PNG screenshot can
      // come back larger as a JPEG.
      return shrunk && shrunk.size < file.size ? shrunk : file;
    }),
  );
}
