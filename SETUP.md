# Setup, end to end

Four stages: database → Gemini key → local testing → deploy. Each ends with a
check that either passes or tells you what is wrong, so you never carry a broken
assumption into the next one.

Throughout, `npm run check` is the doctor. Run it whenever something seems off.

---

## Stage 1 — Database (Neon)

**1.1** Sign up at [neon.com](https://neon.com) (free tier is plenty — this app
stores a few rows per extraction).

**1.2** Create a project. Any region; pick one near you.

**1.3** From the project dashboard, copy the **pooled** connection string. It
looks like:

```
postgresql://user:password@ep-something-pooler.region.aws.neon.tech/neondb?sslmode=require
```

The word `-pooler` matters. The unpooled string works but opens a fresh
connection per serverless invocation, which is exactly what you don't want.

**1.4** Open `.env.local` and set it:

```bash
DATABASE_URL=postgresql://...   # the pooled string you just copied
```

**1.5** Generate an auth secret and set that too:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
AUTH_SECRET=<the output>
```

**1.6** Create the tables, then an admin account:

```bash
npm run init-db
npm run create-admin -- you@example.com
```

`create-admin` prints a generated password **once**. Copy it now — only the hash
is stored, so it cannot be recovered. (`-- --reset` issues a new one if you lose
it.)

**Check:**

```bash
npm run check
```

You want `database reachable`, `schema applied`, and `admin account exists` all
passing. `GEMINI_API_KEY` still failing is expected at this stage.

---

## Stage 2 — Gemini API key (paid tier)

The tier is the whole ballgame here. On the **free** tier Google uses submitted
content to develop its products and human reviewers may read it. On the **paid**
tier it does neither. Same key format, no way to tell them apart from the API —
so this stage is about billing, not about the key.

**2.1** Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
and create an API key. Since you already have a Google Cloud project with
billing, attach the key to that project rather than letting it make a new one.

**2.2** Go to [aistudio.google.com/projects](https://aistudio.google.com/projects)
and find your project's **Billing Tier** column.

- If it says **Set up billing** — click it and attach your existing Cloud Billing
  account.
- If it says **Set up Prepay** — the billing account is attached but needs
  funding. Prepay the **$10 minimum** to activate.
- You want it to stop saying either of those things.

**2.3** Put the key in `.env.local`:

```bash
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-3.7-flash
```

**2.4** Once the Billing Tier column confirms you are actually on paid, and not
before:

```bash
GEMINI_PAID_TIER_CONFIRMED=true
```

This flag only controls what `/privacy` tells your users. Setting it while still
on the free tier makes the app lie to them, which is worse than the warning it
replaces.

**Check:**

```bash
npm run check
```

All five lines should pass. If `gemini reachable` fails, the message says which
of the three usual causes it is — bad key, wrong model name, or free-tier quota.

---

## Stage 3 — Test locally

**3.1** Generate synthetic sheets. Invented names, so no real attendee data goes
near a test run:

```bash
npm run make-sample-pdf -- --pages 2
npm run make-sample-pdf -- --pages 11
```

**3.2** Run the offline suite — no network, no services:

```bash
npm test
```

This covers the schema, the credit deduction under concurrency, PDF and photo
gatekeeping, page ordering, workbook naming, the workbook itself, and log
redaction.

**3.3** Start the app:

```bash
npm run dev
```

**3.4** Walk the three flows at <http://localhost:3000>:

| | What to do | What should happen |
|---|---|---|
| Login | Sign in as your admin | Lands on `/admin` |
| Admin | Create a user with 5 credits | Appears in the table; password shown once |
| User | Sign out, sign in as that user | Lands on `/extract`, shows 5 credits |
| Extract | Drop `samples/sample-sheet-2p.pdf` | Downloads `sample-sheet-2p.xlsx`; credits drop to 4 |
| Limit | Drop `samples/sample-sheet-11p.pdf` | Rejected instantly, **no upload**, credits unchanged |
| Photos | Drop two phone photos of sign-in sheets | "Preparing…", then both listed in page order; one credit |
| Mixing | Drop a PDF and a photo together | Rejected as `mixed_types`, **no upload** |

The photo row is the one worth doing on real hardware rather than with files
copied off a laptop. It exercises the browser-side resize, which is what makes a
set of 3 MB phone photos fit inside a 4 MB request at all.

**3.5** Open the downloaded xlsx. It is named after the PDF you uploaded, or —
for photos — after the event and date printed on the sheet. Columns should match
the sheet, with `Page` prepended. Anything the model could not read confidently is the literal text
`UNCLEAR`, in bold.

**3.6** Two checks worth doing by hand, because they are the ones that would fail
silently:

```bash
# Server-side page limit, bypassing the browser entirely.
# Expect 400 — the browser check is convenience, not a control.
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -F "file=@samples/sample-sheet-11p.pdf" http://localhost:3000/api/extract

# Privilege separation: a normal user hitting an admin route.
# Expect 403. Copy the cookie from DevTools > Application > Cookies while
# signed in as the non-admin user.
curl -s -H "Cookie: authjs.session-token=<paste>" \
  http://localhost:3000/api/admin/users
```

**3.7** Confirm nothing leaked. Search the dev server output for a name from the
sample sheet:

```bash
# Expect no matches.
```

Search your terminal scrollback for `Raghunathan`. Finding it means something is
logging content and needs fixing before you deploy.

---

## Stage 4 — Deploy to Vercel

**4.1** Commit and push to GitHub:

```bash
git add -A
git commit -m "Registration extractor"
git branch -M main
git remote add origin https://github.com/<you>/registration-extractor.git
git push -u origin main
```

`.env.local` and `samples/` are gitignored — verify with `git status` before
pushing that neither appears.

**4.2** At [vercel.com/new](https://vercel.com/new), import the repository.
Framework detection should say Next.js; leave the build settings alone.

**4.3** Add environment variables before the first deploy. Same values as
`.env.local`, **except** generate a *different* `AUTH_SECRET` for production:

| Variable | Value |
|---|---|
| `AUTH_SECRET` | a fresh 32-byte secret, **not** your local one |
| `DATABASE_URL` | the same pooled Neon string |
| `GEMINI_API_KEY` | your paid-tier key |
| `GEMINI_MODEL` | `gemini-3.7-flash` |
| `MAX_PAGES` | `10` (also the photo limit) |
| `MAX_UPLOAD_BYTES` | `4000000` (the whole request, not per file) |

Set every one for **Production, Preview and Development**, or preview builds
fail with a missing `AUTH_SECRET`.

`GEMINI_PAID_TIER_CONFIRMED` is no longer read by anything — `/privacy` stopped
varying its wording on the tier — so there is no need to set it.

You do **not** need `AUTH_URL` — Auth.js detects the Vercel deployment URL.

**4.4** Deploy. The database already has its schema and your admin account from
Stage 1, so there is nothing to run against production.

**4.5** Smoke-test the deployment: sign in, upload the 2-page sample, confirm the
download. Then check the logs:

```bash
npx vercel logs <your-deployment-url>
```

You should see JSON lines with `event`, `status`, `ms`, `userId`, `pageCount` —
and no names anywhere.

### Notes on the platform

- **Hobby is enough.** With Fluid compute, Node functions get a 300s default on
  every plan. `maxDuration = 120` on the extract route is a ceiling we lower, not
  a limit being raised.
- **4.5 MB request cap.** `MAX_UPLOAD_BYTES` sits below it so users get a useful
  message rather than a bare platform `413`. Tell people to scan at 200 DPI
  grayscale — roughly 300 KB per page, so ten pages fit comfortably.
- **Photos are resized in the browser to meet that cap**, since a phone photo is
  2–5 MB on its own. Nothing to configure; raising `MAX_UPLOAD_BYTES` will not
  help, because the platform cap above it is the real ceiling. The exception is
  HEIC: Chrome and Firefox cannot decode one, so an iPhone photo uploaded from a
  desktop is sent at full size and may be refused. Uploading from the phone
  itself, or saving as JPEG first, both work.
- **One database for both.** Local and production share the Neon project, which
  is fine at this size. If you'd rather separate them, create a Neon branch for
  development and point `.env.local` at that instead.

---

## When something breaks

| Symptom | Cause |
|---|---|
| `npm run check` says DATABASE_URL missing, but it's in the file | You edited `.env` instead of `.env.local` |
| `fetch failed` on the database | Connection string wrong, or the Neon project is paused — open the dashboard to wake it |
| `ConnectTimeoutError` / `UND_ERR_CONNECT_TIMEOUT`, intermittently | Long round trip to a distant Neon region. See below. |
| `key rejected` | Key truncated on copy; regenerate it |
| `quota exhausted` | Still on the free tier — revisit Stage 2.2 |
| Login loops back to `/login` | `AUTH_SECRET` missing or different between build and runtime |
| `413` on upload | File over 4.5 MB — Vercel rejected it before our code ran |
| "needs a password" on a document that opens fine | Run `npm run diagnose -- <file>`; see below |
| Extraction fails, credits unchanged | Working as designed; check the logged `reason` |

### A document is refused as password-protected

Inspect it:

```bash
npm run diagnose -- "path\to\document.pdf"
```

This prints structure only — never page content — so the output is safe to paste
into a bug report.

Most PDFs that look protected are not. Scanners, Acrobat and document-management
systems routinely attach an `/Encrypt` dictionary purely to carry permission
flags ("no copying", "no modifying") with **no password at all**; those open
instantly in any reader. The app once refused every one of them, because the
library's `isEncrypted` flag is true whenever that dictionary exists and says
nothing about whether a password is needed.

It now opens each document with an empty password: succeeding means
permissions-only and it is accepted, while a genuine password requirement throws
and is refused. If `diagnose` reports `opens with no password: yes` alongside
`has /Encrypt: true`, that is the case, and the document will go through.

To reproduce either kind by hand:

```bash
npm run make-sample-pdf -- --pages 2 --encrypt          # permissions-only
npm run make-sample-pdf -- --pages 2 --password letmein # genuinely protected
```

### Intermittent connect timeouts in local dev

If the database works, then randomly doesn't, the cause is usually distance
rather than configuration: a Neon project in `us-east-1` reached from Europe or
further east is a ~230 ms round trip on a good day and several seconds on a bad
one, against a 10-second connect timeout.

Two things in the code already absorb most of this:

- Reads and writes retry on failures that provably never reached the server
  (`UND_ERR_CONNECT_TIMEOUT` and friends). Mid-flight failures are deliberately
  *not* retried — see [src/lib/db.ts](src/lib/db.ts) for why that distinction
  protects the credit ledger.
- Multi-query pages use `batch()` so they cost one round trip rather than
  several. The admin dashboard went from three parallel requests (worst case
  ~6 s, occasionally past the timeout) to one at a steady ~230 ms.

**This does not affect production.** Vercel's default region is `iad1`, which is
`us-east-1` — the same place your database lives, so deployed functions reach it
in single-digit milliseconds. The latency is a local-development artefact.

If local dev is still painful, create the Neon project in a region near you and
update `DATABASE_URL`. Note that this moves the database away from the deployed
functions, so prefer a separate Neon project (or branch) for local work rather
than relocating the one production uses.
