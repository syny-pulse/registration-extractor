/**
 * Generates a synthetic registration sheet for testing.
 *
 * Uses invented names so nobody has to hand a real sign-in sheet to a test run.
 * The text is typeset rather than handwritten, so this exercises the plumbing —
 * upload, page count, schema, workbook — not the handwriting recognition
 * itself. For that you need a genuine scan.
 *
 *   npm run make-sample-pdf                      -> samples/sample-sheet-2p.pdf
 *   npm run make-sample-pdf -- --pages 11        -> for the page-limit refusal
 *   npm run make-sample-pdf -- --encrypt         -> permissions-only, no password
 *   npm run make-sample-pdf -- --encrypt RC4-128 -> the same, older cipher
 *   npm run make-sample-pdf -- --password letmein-> genuinely password-protected
 *
 * `--encrypt` reproduces what scanners and office suites emit constantly: an
 * /Encrypt dictionary holding permission flags, with no user password, opening
 * in any reader without a prompt. Those were once refused as "password
 * protected"; they should now be accepted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const pageArg = args.indexOf("--pages");
const pageCount = pageArg >= 0 ? Number(args[pageArg + 1]) : 2;
const outArg = args.indexOf("--out");

const encryptArg = args.indexOf("--encrypt");
const passwordArg = args.indexOf("--password");
const userPassword = passwordArg >= 0 ? args[passwordArg + 1] : undefined;

// A bare --encrypt takes the default cipher; --encrypt RC4-128 names one.
const nextAfterEncrypt = encryptArg >= 0 ? args[encryptArg + 1] : undefined;
const algorithm =
  nextAfterEncrypt && !nextAfterEncrypt.startsWith("--") ? nextAfterEncrypt : "AES-256";
const encrypt = encryptArg >= 0 || passwordArg >= 0;

const COLUMNS = [
  { header: "Name", width: 170 },
  { header: "Organisation", width: 150 },
  { header: "Email", width: 160 },
  { header: "Time in", width: 60 },
];

const ATTENDEES = [
  ["Priya Raghunathan", "Northbrook Trust", "priya.r@example.org", "09:05"],
  ["Tomas Eriksson", "Vellum & Co", "t.eriksson@example.com", "09:11"],
  ["Amara Okonkwo", "Riverside Clinic", "a.okonkwo@example.net", "09:14"],
  ["Declan Fitzgerald", "", "declan.f@example.org", "09:20"],
  ["Yuki Tanabe", "Harbour Lights", "y.tanabe@example.com", "09:22"],
  ["Beatriz Salgado", "Northbrook Trust", "", "09:31"],
  ["Idris Mahmoud", "Fenwick Partners", "i.mahmoud@example.org", "09:38"],
  ["Helena Vogt", "Riverside Clinic", "h.vogt@example.net", "09:40"],
  ["Callum Whitfield", "Vellum & Co", "c.whitfield@example.com", "09:47"],
  ["Nadia Chaudhry", "Harbour Lights", "n.chaudhry@example.org", "09:52"],
];

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const line = rgb(0.6, 0.6, 0.6);

for (let p = 0; p < pageCount; p += 1) {
  const page = doc.addPage([595, 842]); // A4
  let y = 780;

  page.drawText("Annual General Meeting — Attendance Register", {
    x: 40,
    y,
    size: 14,
    font: bold,
  });
  y -= 18;
  page.drawText(`Sheet ${p + 1} of ${pageCount}`, { x: 40, y, size: 9, font });

  y -= 30;
  let x = 40;
  for (const column of COLUMNS) {
    page.drawText(column.header, { x, y, size: 10, font: bold });
    x += column.width;
  }

  y -= 6;
  page.drawLine({
    start: { x: 40, y },
    end: { x: 555, y },
    thickness: 1,
    color: rgb(0, 0, 0),
  });

  y -= 20;
  for (let i = 0; i < ATTENDEES.length; i += 1) {
    const row = ATTENDEES[(p * 3 + i) % ATTENDEES.length];
    x = 40;
    for (let c = 0; c < COLUMNS.length; c += 1) {
      if (row[c]) page.drawText(row[c], { x, y: y + 4, size: 9, font });
      x += COLUMNS[c].width;
    }
    page.drawLine({
      start: { x: 40, y: y - 4 },
      end: { x: 555, y: y - 4 },
      thickness: 0.5,
      color: line,
    });
    y -= 26;
  }
}

if (encrypt) {
  doc.encrypt({
    // Always set an owner password so permissions are enforceable. Leaving
    // userPassword undefined is what makes it permissions-only: the file opens
    // with no prompt, which is the case that was being wrongly refused.
    ownerPassword: "owner-secret",
    userPassword,
    algorithm,
    // RC4 is refused by default as broken, but older scanners still emit it.
    allowWeakCryptography: true,
    permissions: { printing: "highResolution", copying: false, modifying: false },
  });
}

const outDir = join(here, "..", "samples");
mkdirSync(outDir, { recursive: true });

const suffix = userPassword ? "-password" : encrypt ? `-${algorithm.toLowerCase()}` : "";
const out =
  outArg >= 0 ? args[outArg + 1] : join(outDir, `sample-sheet-${pageCount}p${suffix}.pdf`);

writeFileSync(out, await doc.save());

const how = userPassword
  ? `password-protected (password: ${userPassword})`
  : encrypt
    ? `permissions-only ${algorithm}, opens without a password`
    : "unencrypted";
console.log(`Wrote ${out} (${pageCount} pages, ${how})`);
