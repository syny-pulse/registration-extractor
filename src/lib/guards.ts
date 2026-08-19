import { auth } from "@/auth";
import { getUserById, type User } from "./users";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Resolves the signed-in user from the database.
 *
 * The session cookie is proof of identity, not a source of truth about state:
 * roles and credit balances are re-read here on every request. Middleware has
 * already turned away anonymous callers, but these routes are also reachable
 * directly, so the check is repeated rather than assumed.
 */
export async function requireUser(): Promise<User> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new HttpError(401, "unauthenticated", "Not signed in.");
  }

  const user = await getUserById(session.user.id);
  if (!user) {
    // A valid token for an account that has since been deleted.
    throw new HttpError(401, "unknown_user", "Account no longer exists.");
  }
  return user;
}

/**
 * As requireUser, but insists on a live admin role from the database rather
 * than trusting the `role` claim baked into the JWT, which can be stale for as
 * long as the token lives.
 */
export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "admin") {
    throw new HttpError(403, "forbidden", "Admin access required.");
  }
  return user;
}
