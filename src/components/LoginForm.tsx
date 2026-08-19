"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { Button, Field, Input, Notice } from "./ui";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const result = await signIn("credentials", {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      redirect: false,
    });

    if (result?.error) {
      // One message for every failure mode. Distinguishing "no such account"
      // from "wrong password" would turn this form into a way to test whether
      // an address has an account here.
      setError("Email or password is incorrect.");
      setBusy(false);
      return;
    }

    // Landing on "/" lets the server decide between /admin and /extract, so the
    // client never has to know the role.
    window.location.href = "/";
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <Field label="Email">
        <Input
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          disabled={busy}
        />
      </Field>

      <Field label="Password">
        <Input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={busy}
        />
      </Field>

      {error && <Notice tone="error">{error}</Notice>}

      <Button type="submit" disabled={busy} className="w-full">
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
