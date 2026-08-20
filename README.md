# Registration Extractor

Turns scanned or photographed paper registration sheets into a spreadsheet,
without keeping the sheets.

Someone runs an event, collects handwritten sign-ins on paper, and needs the data
as an Excel file. This does that in one step: upload a scanned PDF — or just
photograph each sheet with a phone — and download the workbook.

The constraint that shapes the whole design is **retention**. Attendee names and
contact details are personal data the operator does not want to be custodian of,
so non-retention here is structural rather than promised:

- documents are processed in memory and never written to any store;
- the extracted table exists only in the file the user downloads;
- the database has no column that could hold a name, an email, or a filename.

A full dump of this database leaks account emails and per-user usage counts. That
is the entire blast radius.

---

## Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Auth | Auth.js v5 (`next-auth@beta`), Credentials, JWT sessions |
| Database | Neon Postgres via `@neondatabase/serverless` — raw SQL, no ORM |
| Model | Gemini API `gemini-3.7-flash` via `@google/genai` |
| Excel | `exceljs`, built in memory |
| PDF | `@cantoo/pdf-lib`, for page counting on both client and server |
| Photos | JPEG, PNG, WebP, HEIC/HEIF — the formats the Gemini API decodes inline |
| Styling | Tailwind v4 (CSS-first config) |

---

## Getting started

**[SETUP.md](SETUP.md) walks the whole thing end to end** — Neon, the Gemini key,
local testing, and deploying to Vercel. The short version:

```bash
npm install
cp .env.example .env.local     # then fill it in — see below
npm run init-db                # applies db/schema.sql
npm run create-admin -- you@example.com
npm run check                  # verifies db + Gemini are actually reachable
npm run dev
```

`create-admin` prints a generated password once. It is the only way an admin
comes into existence; there is no self-signup path anywhere in the app.

### Environment

Every variable is documented in [.env.example](.env.example). The one worth
calling out is **`GEMINI_PAID_TIER_CONFIRMED`** — see below.

---

## How your data is handled

Our own side of this is settled by construction: documents are never written to
storage, the extracted table exists only in the user's download, and the database
has no column that could hold a name. That part is not a promise, it is the
schema — and [tests/database.test.ts](tests/database.test.ts) asserts it.

What needs care is the third party.

This deployment uses the **Gemini Developer API** with an AI Studio key. The tier
you are on changes the terms completely:

| | Free tier | Paid tier |
|---|---|---|
| Used to improve/train Google's products | **Yes** | No |
| Human reviewers may read it | **Yes** | No |
| Logged for abuse detection | Yes | Yes — limited period, **no opt-out** |

So: **put the key's project on the paid tier before any real registration sheet
goes through it.** AI Studio → the project → set up billing. Then set
`GEMINI_PAID_TIER_CONFIRMED=true`.

The key looks identical on both tiers and no API response tells you which one you
are on, so code cannot check this — only a person can. Until the flag is set,
`/privacy` tells users not to upload real sheets. That warning is the honest
default and is deliberately what ships. Do not flip the flag to silence it.

### The limit of this tier

Even on the paid tier, Google logs prompts and responses for a limited period to
detect misuse, and **there is no way to opt out on the Developer API**. For a
window after processing, uploaded pages exist in Google's abuse-detection logs.

`/privacy` says this plainly rather than implying the pages evaporate.

If that window is unacceptable for your documents, the Developer API cannot get
you there and no configuration will change that. **Zero data retention is only
available on Google Cloud's Vertex AI**, and only after two out-of-band steps:
disabling input caching project-wide via the `cacheConfig` endpoint, and having
Google approve an abuse-monitoring logging exception. Moving over means swapping
`getClient()` in [src/lib/gemini.ts](src/lib/gemini.ts) for a Vertex client
(`enterprise: true` plus project, location, and service-account credentials) —
everything downstream of it stays as it is.

The line that stays true on every tier: **pages transit Google's infrastructure
while they are being read.**

---

## How a request flows

`POST /api/extract` is the only processing route.

1. Resolve the session, then re-read the user **from the database** — the JWT
   proves identity, not state.
2. Refuse with `402` if the balance is under one credit.
3. Validate the upload (`inspectUpload` in [src/lib/upload.ts](src/lib/upload.ts)):
   either one PDF or up to `MAX_PAGES` photos, never a mix; within the size cap
   for the whole request; within the page limit; not encrypted; and, for photos,
   actually the format the bytes say they are. The browser already checked all
   of this to avoid a pointless upload; the server checks it again because the
   browser is not a control.
4. Send the pages inline to Gemini in a single call — the PDF, or every photo in
   page order. No intermediate upload, nothing to clean up.
5. Validate the response against a schema, square up row widths, build the
   workbook in memory, and name it — after the PDF, or after the event and date
   the model read off a photographed sheet.
6. Charge one credit and write the usage row — **as a single SQL statement**.
7. Stream the xlsx back.

A failure anywhere in steps 4–5 records a `failed` usage row and charges nothing.
Work the user did not get should not cost them a credit.

### Why the credit deduction is one statement

Neon's HTTP driver has no interactive transactions — there is no `BEGIN`/`COMMIT`
round trip available. So atomicity comes from writing the work as a single
statement instead (`spendCredit` in [src/lib/users.ts](src/lib/users.ts)): a CTE
deducts the credit only if one is available, and the `INSERT` selects from that
CTE, so the log row exists if and only if the deduction happened.

The deduction runs *after* a successful extraction. The trade-off that accepts:
a user firing several uploads at once on a single credit can get a small bounded
overdraw. With admin-provisioned accounts that is the better side to err on —
losing a paid-for credit to a crash is visible and annoying, a bounded overdraw
is neither. (If it ever matters, switch to reserve-then-refund.)

---

## Logging

All logging goes through [src/lib/log.ts](src/lib/log.ts), which accepts a fixed
shape — event, status, timing, user id, page count — and nothing else. There is
no free-form message field, on purpose.

Error paths log the error's *class and status* but never `error.message`.
Provider SDKs routinely echo request content back inside error strings, and that
is the realistic path by which an attendee's name would end up in a log that
outlives the request.

If you add logging, add it there.

---

## Testing

```bash
npm test          # no external services required
npm run typecheck
npm run build
```

`tests/database.test.ts` runs the real functions from `src/lib/users.ts` against
**PGlite** — Postgres 18 compiled to WASM — so `db/schema.sql`, the `CHECK`
constraints, and the credit CTE are exercised against genuine Postgres
semantics rather than a mock. The concurrency case fires ten simultaneous
deductions at a three-credit account and asserts the invariant that matters:
three successes, three log rows, balance zero.

`tests/extraction.test.ts` covers PDF gatekeeping, row normalization, the
workbook, and log redaction. `tests/uploads.test.ts` covers the photo path:
format detection from magic numbers rather than file names, page ordering, the
per-request size cap, and workbook naming — including what happens when the
model-supplied title is hostile.

`npm run make-sample-pdf` writes synthetic sheets to `samples/` using invented
names, so nobody has to hand a real sign-in sheet to a test run:

```bash
npm run make-sample-pdf -- --pages 2     # happy path
npm run make-sample-pdf -- --pages 11    # page-limit refusal
```

These are typeset rather than handwritten, so they exercise the plumbing — page
counting, schema, workbook, credits — not the handwriting recognition. For that
you need a genuine scan.

### End-to-end checks worth doing by hand

- **Privilege separation.** Sign in as a non-admin, then `curl /api/admin/users`
  with that user's session cookie. Expect `403`. This proves the server-side role
  re-read works and the UI gate is not load-bearing.
- **Page limit, server side.** `curl` the 11-page sample straight at
  `/api/extract`, bypassing the browser check entirely. Expect `400`.
- **Photo path, end to end.** Photograph two sign-in sheets with a phone, upload
  both, and check that the workbook's `Page` column matches which sheet each row
  came from, and that the file is named after the event printed on the sheet.
- **Failure is free.** Point `GEMINI_MODEL` at a nonsense model id. The request
  should fail, credits should be unchanged, and a `failed` row should appear.
- **Retention.** `grep` the dev server output for a name from the test sheet.
  Expect nothing. Repeat against `vercel logs` after the first deploy.

---

## Deploying

Vercel, Node runtime. Worth knowing:

- **Request bodies are capped at 4.5 MB**, and so are responses. `MAX_UPLOAD_BYTES`
  sits below that so users get a useful message instead of a bare platform `413`.
  Scanning at 200 DPI in grayscale keeps a page around 300 KB, which is plenty for
  handwriting.
- **That cap is why photos are re-encoded in the browser.** A photo off a current
  phone is 2–5 MB, so ten of them would exceed the body limit several times over
  and the photo path would be unusable at its stated limit. `shrinkPhotos` in
  [src/lib/downscale.ts](src/lib/downscale.ts) resizes each one to ~190 DPI across
  an A4 sheet — the same quality bar the scanning advice assumes — and drops the
  EXIF block, GPS included, on the way past. HEIC is the gap: Chrome and Firefox
  cannot decode one, so an iPhone photo uploaded from a desktop is sent as-is and
  may be refused on size. The message says so.
- **Function duration:** with Fluid compute (default on new projects) the Node
  default is 300s on every plan, Hobby included. `maxDuration = 120` on the
  extract route is therefore a ceiling we *lower* to bound cost — not a limit
  being raised. **Pro is not required for this.**
- **No filesystem use anywhere.** Everything is buffers already, which is what
  serverless wants.
