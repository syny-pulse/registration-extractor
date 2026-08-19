import Link from "next/link";

export const metadata = { title: "How your documents are handled" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">How your documents are handled</h1>

      <div className="mt-10 space-y-8 text-sm leading-relaxed">
        <section>
          <h2 className="font-semibold">1. Documents are never stored</h2>
          <p className="mt-2 text-muted">
            An uploaded PDF is held in memory for the few seconds it takes to process, then
            released. It is never written to a disk, an object store, or a database. There is
            no copy for us to retain, hand over, or lose.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">2. Extracted data exists only in your download</h2>
          <p className="mt-2 text-muted">
            The spreadsheet is built in memory and streamed straight to your browser. Every
            column present on the sheet is transcribed — which, depending on the form, may
            include names, signatures, phone numbers, email addresses, or times of arrival.
            Once the download finishes, the only copy of that data is the file on your own
            computer, and looking after it is your responsibility.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">3. The pages pass through Google during processing</h2>
          <p className="mt-2 text-muted">
            Handwriting is read by Google&rsquo;s Gemini model via the Gemini API. Your pages
            transit Google&rsquo;s infrastructure while they are being read. This is the one
            point at which the document leaves our control.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">4. What we do keep</h2>
          <p className="mt-2 text-muted">
            Your account email, a hash of your password, your credit balance, and one row per
            extraction recording the date, the page count, and whether it succeeded. That is
            the entire contents of our database. There is no table that could hold a name, and
            we do not even record the filename you uploaded.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">5. Logs</h2>
          <p className="mt-2 text-muted">
            Server logs record timings, status codes, and account identifiers. Document
            content is never logged, including inside error messages.
          </p>
        </section>
      </div>

      <p className="mt-14 text-xs text-muted">
        <Link href="/" className="underline underline-offset-4 hover:text-ink">
          Back to the application
        </Link>
      </p>
    </main>
  );
}
