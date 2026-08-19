"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import type { UserWithUsage } from "@/lib/users";
import type { UsageLogRow, UsageTotals } from "@/lib/usage";
import { Button, Card, Field, Input, Notice, Td, Th } from "./ui";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function AdminUsers({
  users,
  logs,
  totals,
  currentUserId,
}: {
  users: UserWithUsage[];
  logs: UsageLogRow[];
  totals: UsageTotals;
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(url: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...init.headers },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Request failed.");
        return false;
      }
      startTransition(() => router.refresh());
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");

    const ok = await send("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        role: data.get("role") === "admin" ? "admin" : "user",
        credits: Number(data.get("credits") ?? 0),
      }),
    });

    if (ok) {
      form.reset();
      // The password is never recoverable from the database, so it is echoed
      // once here for the admin to pass on.
      setNotice(`Created ${email}. Give them this password now — it is not stored: ${password}`);
    }
  }

  function adjustCredits(user: UserWithUsage, delta: number) {
    void send(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ credits: Math.max(0, user.credits + delta) }),
    });
  }

  function setCredits(user: UserWithUsage) {
    const raw = window.prompt(`Set credits for ${user.email}`, String(user.credits));
    if (raw === null) return;
    const next = Number(raw);
    if (!Number.isInteger(next) || next < 0) {
      setError("Credits must be a whole number of zero or more.");
      return;
    }
    void send(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ credits: next }),
    });
  }

  async function resetPassword(user: UserWithUsage) {
    const next = window.prompt(
      `New password for ${user.email} (at least 10 characters). It is stored only as a hash, so write it down before closing this.`,
    );
    if (next === null) return;

    const ok = await send(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ password: next }),
    });
    if (ok) setNotice(`Password reset for ${user.email}. Pass it on now — it is not recoverable.`);
  }

  function removeUser(user: UserWithUsage) {
    if (!window.confirm(`Delete ${user.email}? Their usage history goes too.`)) return;
    void send(`/api/admin/users/${user.id}`, { method: "DELETE" });
  }

  const working = busy || pending;

  return (
    <div className="space-y-12">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      <section>
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Accounts</h2>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse">
            <thead>
              <tr>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Credits</Th>
                <Th>Extractions</Th>
                <Th>Last used</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <Td>
                    {user.email}
                    {user.id === currentUserId && (
                      <span className="ml-2 text-xs text-muted">(you)</span>
                    )}
                  </Td>
                  <Td>{user.role}</Td>
                  <Td className="font-semibold tabular-nums">{user.credits}</Td>
                  <Td className="tabular-nums">
                    {user.successful_extractions}
                    {user.failed_extractions > 0 && (
                      <span className="text-muted"> · {user.failed_extractions} failed</span>
                    )}
                  </Td>
                  <Td className="text-muted">{formatDate(user.last_used_at)}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        variant="secondary"
                        className="h-8 px-2"
                        disabled={working}
                        onClick={() => adjustCredits(user, 10)}
                        title="Add 10 credits"
                      >
                        +10
                      </Button>
                      <Button
                        variant="secondary"
                        className="h-8 px-2"
                        disabled={working}
                        onClick={() => setCredits(user)}
                      >
                        Set
                      </Button>
                      <Button
                        variant="secondary"
                        className="h-8 px-2"
                        disabled={working}
                        onClick={() => resetPassword(user)}
                      >
                        Password
                      </Button>
                      <Button
                        variant="quiet"
                        className="h-8 px-2"
                        disabled={working || user.id === currentUserId}
                        onClick={() => removeUser(user)}
                      >
                        Delete
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      <section>
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Create account</h2>
        <Card className="p-5">
          <form onSubmit={onCreate} className="grid gap-4 sm:grid-cols-4 sm:items-end">
            <div className="sm:col-span-2">
              <Field label="Email">
                <Input name="email" type="email" required disabled={working} />
              </Field>
            </div>
            <Field label="Temporary password">
              <Input
                name="password"
                type="text"
                minLength={10}
                required
                disabled={working}
                placeholder="min 10 characters"
              />
            </Field>
            <Field label="Credits">
              <Input
                name="credits"
                type="number"
                min={0}
                defaultValue={10}
                disabled={working}
              />
            </Field>
            <div className="sm:col-span-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="role" value="admin" disabled={working} />
                Grant admin access
              </label>
            </div>
            <Button type="submit" disabled={working}>
              Create
            </Button>
          </form>
        </Card>
      </section>

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Usage</h2>
          <p className="text-xs text-muted tabular-nums">
            {totals.successful} successful · {totals.failed} failed · {totals.pages} pages
          </p>
        </div>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Account</Th>
                <Th>Pages</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr>
                  <Td className="text-muted">No extractions yet.</Td>
                  <Td>{null}</Td>
                  <Td>{null}</Td>
                  <Td>{null}</Td>
                </tr>
              )}
              {logs.map((row) => (
                <tr key={row.id}>
                  <Td className="text-muted whitespace-nowrap">{formatDate(row.created_at)}</Td>
                  <Td>{row.email}</Td>
                  <Td className="tabular-nums">{row.page_count}</Td>
                  <Td className={row.status === "failed" ? "font-semibold" : "text-muted"}>
                    {row.status}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="mt-3 text-xs text-muted">
          Usage records hold an account, a page count, and an outcome. No filenames and no
          document content are stored anywhere in this system.
        </p>
      </section>
    </div>
  );
}
