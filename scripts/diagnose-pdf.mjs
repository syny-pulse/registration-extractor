/**
 * Reports why a PDF is accepted or refused.
 *
 *   npm run diagnose -- "path\to\document.pdf"
 *
 * Prints structure only — encryption dictionary, page count, size. It never
 * prints page content, extracted text, or anything else from inside the
 * document, for the same reason src/lib/log.ts refuses to: this output gets
 * pasted into bug reports and chat windows.
 */
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

import { PDFDocument, PDFName, PDFDict } from "@cantoo/pdf-lib";

const target = process.argv.slice(2).find((a) => !a.startsWith("--"));

if (!target) {
  console.error('Usage: npm run diagnose -- "path\\to\\document.pdf"');
  process.exit(1);
}
if (!existsSync(target)) {
  console.error(`No such file: ${target}`);
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(target));
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 10);
const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 4_000_000);

const line = (k, v) => console.log(`  ${String(k).padEnd(22)} ${v}`);

console.log(`\n  ${basename(target)}\n`);
line("size", `${(bytes.byteLength / 1_000_000).toFixed(2)} MB` +
  (bytes.byteLength > MAX_BYTES ? `  OVER the ${(MAX_BYTES / 1e6).toFixed(1)} MB limit` : ""));
line("starts with %PDF", String(Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-"));

// --- Structure, read without attempting decryption --------------------------
let structural = null;
try {
  structural = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
} catch (err) {
  line("parse", `FAILED — ${err.message.split("\n")[0].slice(0, 70)}`);
}

if (structural) {
  line("pages", `${structural.getPageCount()}` +
    (structural.getPageCount() > MAX_PAGES ? `  OVER the ${MAX_PAGES}-page limit` : ""));
  line("has /Encrypt", String(structural.isEncrypted));

  if (structural.isEncrypted) {
    // Read the encryption dictionary directly so the report says which scheme
    // this is, not merely that there is one.
    try {
      const context = structural.context;
      const dict = context.lookup(context.trailerInfo.Encrypt, PDFDict);
      const get = (name) => dict?.get(PDFName.of(name));
      console.log();
      line("  /Filter", get("Filter")?.asString?.() ?? "?");
      line("  /V (algorithm)", get("V")?.asNumber?.() ?? "?");
      line("  /R (revision)", get("R")?.asNumber?.() ?? "?");
      line("  /Length", get("Length")?.asNumber?.() ?? "(absent)");
      line("  /ID present", String(!!context.trailerInfo.ID));
    } catch {
      line("  encrypt dict", "could not be read");
    }
  }
}

// --- Does the empty password open it? ---------------------------------------
console.log();
let emptyPasswordWorks = false;
let needsPassword = false;

try {
  const opened = await PDFDocument.load(bytes, { password: "", updateMetadata: false });
  emptyPasswordWorks = true;
  line("opens with no password", `yes (${opened.getPageCount()} pages)`);
} catch (err) {
  const message = err.message ?? String(err);
  needsPassword = /NEEDS PASSWORD|Password incorrect/i.test(message);
  line(
    "opens with no password",
    needsPassword
      ? "NO — a real password is required"
      : `could not tell — ${message.split("\n")[0].slice(0, 60)}`,
  );
}

// --- Verdict ----------------------------------------------------------------
const oldVerdict = !structural
  ? "unreadable"
  : structural.isEncrypted
    ? "REJECTED as password-protected"
    : "accepted";

let newVerdict;
if (needsPassword) newVerdict = "REJECTED — genuinely needs a password";
else if (!emptyPasswordWorks && !structural) newVerdict = "unreadable";
else {
  const pages = structural?.getPageCount() ?? 0;
  if (bytes.byteLength > MAX_BYTES) newVerdict = "rejected — too large";
  else if (pages > MAX_PAGES) newVerdict = `rejected — ${pages} pages`;
  else newVerdict = `accepted (${pages} pages)`;
}

console.log();
line("before the fix", oldVerdict);
line("after the fix", newVerdict);

if (oldVerdict.startsWith("REJECTED") && newVerdict.startsWith("accepted")) {
  console.log(
    "\n  This is the permissions-only case: the document carries an /Encrypt" +
      "\n  dictionary for permission flags but needs no password to open. It was" +
      "\n  being refused for that alone, and now works.\n",
  );
} else if (needsPassword) {
  console.log(
    "\n  This document really is password-protected. Open it in a PDF reader," +
      "\n  save an unprotected copy, and upload that.\n",
  );
} else {
  console.log();
}
