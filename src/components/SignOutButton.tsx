"use client";

import { signOut } from "next-auth/react";
import { Button } from "./ui";

export function SignOutButton() {
  return (
    <Button variant="quiet" onClick={() => signOut({ callbackUrl: "/login" })}>
      Sign out
    </Button>
  );
}
