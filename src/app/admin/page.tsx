import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { AdminUsers } from "@/components/AdminUsers";
import { SignOutButton } from "@/components/SignOutButton";
import { getDashboard } from "@/lib/dashboard";
import { getUserById } from "@/lib/users";

// Credits and usage must reflect the database on every load, not a cached
// render from someone else's request.
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // Middleware already checked the JWT role; this re-read is what actually
  // decides, so a token issued before a demotion cannot open this page.
  const me = await getUserById(session.user.id);
  if (!me || me.role !== "admin") redirect("/extract");

  // One round trip, not three — see getDashboard for why that matters here.
  const { users, logs, totals } = await getDashboard();

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-12 flex items-baseline justify-between gap-4 border-b border-rule pb-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Administration</h1>
          <p className="mt-1 text-sm text-muted">{me.email}</p>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/extract"
            className="text-sm underline underline-offset-4 hover:text-ink text-muted"
          >
            Extract
          </Link>
          <SignOutButton />
        </div>
      </header>

      <AdminUsers users={users} logs={logs} totals={totals} currentUserId={me.id} />
    </main>
  );
}
