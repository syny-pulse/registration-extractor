import { redirect } from "next/navigation";
import Link from "next/link";

import { auth } from "@/auth";
import { LoginForm } from "@/components/LoginForm";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">Registration Extractor</h1>
      <p className="mt-2 mb-10 text-sm text-muted">
        Sign in to convert a scanned registration sheet into a spreadsheet.
      </p>

      <LoginForm />

      <p className="mt-10 text-xs text-muted">
        Accounts are created by an administrator. There is no self-registration.{" "}
        <Link href="/privacy" className="underline underline-offset-4 hover:text-ink">
          How your documents are handled
        </Link>
        .
      </p>
    </main>
  );
}
