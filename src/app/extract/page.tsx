import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { SignOutButton } from "@/components/SignOutButton";
import { Uploader } from "@/components/Uploader";
import { MAX_PAGES, MAX_UPLOAD_BYTES } from "@/lib/config";
import { getUserById } from "@/lib/users";

// The credit count must be the live balance, never a cached render.
export const dynamic = "force-dynamic";

export default async function ExtractPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const me = await getUserById(session.user.id);
  if (!me) redirect("/login");

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-10 flex items-baseline justify-between gap-4 border-b border-rule pb-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Registration Extractor</h1>
          <p className="mt-1 text-sm text-muted">{me.email}</p>
        </div>
        <div className="flex items-center gap-4">
          {me.role === "admin" && (
            <Link
              href="/admin"
              className="text-sm text-muted underline underline-offset-4 hover:text-ink"
            >
              Admin
            </Link>
          )}
          <SignOutButton />
        </div>
      </header>

      <Uploader
        credits={me.credits}
        maxPages={MAX_PAGES}
        maxUploadBytes={MAX_UPLOAD_BYTES}
      />

      <footer className="mt-16 border-t border-rule pt-5">
        <p className="text-xs text-muted">
          Your document is processed in memory and never written to storage. The spreadsheet
          exists only in your download.{" "}
          <Link href="/privacy" className="underline underline-offset-4 hover:text-ink">
            How your documents are handled
          </Link>
          .
        </p>
      </footer>
    </main>
  );
}
