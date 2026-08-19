import bcrypt from "bcryptjs";
import { sql } from "./db";

export type Role = "admin" | "user";

export type User = {
  id: string;
  email: string;
  role: Role;
  credits: number;
  created_at: string;
};

/** A user row joined with their lifetime extraction count, for the admin table. */
export type UserWithUsage = User & {
  successful_extractions: number;
  failed_extractions: number;
  last_used_at: string | null;
};

const BCRYPT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Verifies an email/password pair.
 *
 * Runs the bcrypt comparison against a dummy hash when the user does not exist,
 * so that a missing account and a wrong password take the same time. Without
 * this, response timing tells an attacker which addresses have accounts.
 */
// A real 12-round hash of a throwaway string. It has to be genuinely valid:
// bcrypt.compare against a malformed hash returns false immediately without
// doing the work, which would leave exactly the timing signal this is meant to
// remove.
const DUMMY_HASH = "$2b$12$D4vVwSG5TT3xX1v.XqaiU.0QwXHBnoI9.5wJ3nX1WoGBFvpUX3/BG";

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<User | null> {
  const rows = (await sql`
    SELECT id, email, password_hash, role, credits, created_at
    FROM users
    WHERE email = ${normalizeEmail(email)}
  `) as Array<User & { password_hash: string }>;

  const row = rows[0];
  const matches = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !matches) return null;

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    credits: row.credits,
    created_at: row.created_at,
  };
}

export async function getUserById(id: string): Promise<User | null> {
  const rows = (await sql`
    SELECT id, email, role, credits, created_at FROM users WHERE id = ${id}
  `) as User[];
  return rows[0] ?? null;
}

export async function createUser(params: {
  email: string;
  password: string;
  role: Role;
  credits: number;
}): Promise<User> {
  const passwordHash = await hashPassword(params.password);
  const rows = (await sql`
    INSERT INTO users (email, password_hash, role, credits)
    VALUES (${normalizeEmail(params.email)}, ${passwordHash}, ${params.role}, ${params.credits})
    RETURNING id, email, role, credits, created_at
  `) as User[];
  return rows[0];
}

export async function updateUser(
  id: string,
  changes: { credits?: number; role?: Role; password?: string },
): Promise<User | null> {
  // Applied as separate statements rather than a built-up SET clause: with at
  // most three independent fields, the dynamic-SQL machinery costs more than it
  // saves and gives string interpolation a place to creep back in.
  if (changes.credits !== undefined) {
    await sql`UPDATE users SET credits = ${changes.credits} WHERE id = ${id}`;
  }
  if (changes.role !== undefined) {
    await sql`UPDATE users SET role = ${changes.role} WHERE id = ${id}`;
  }
  if (changes.password !== undefined) {
    const hash = await hashPassword(changes.password);
    await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${id}`;
  }
  return getUserById(id);
}

export async function deleteUser(id: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM users WHERE id = ${id} RETURNING id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

/** True once no admin would remain — used to refuse the last-admin lockout. */
export async function isLastAdmin(id: string): Promise<boolean> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND id <> ${id}
  `) as Array<{ n: number }>;
  return rows[0].n === 0;
}

/**
 * Charges one credit and records the extraction, atomically.
 *
 * Neon's HTTP driver has no interactive transactions, so this is written as a
 * single statement: the CTE deducts only if a credit is actually available, and
 * the INSERT selects from that CTE, so the log row exists if and only if the
 * decrement happened. Nothing can interleave between the two.
 *
 * Returns the remaining balance, or null if the user turned out to have no
 * credits (which the caller's earlier check should normally have caught — this
 * is the guard against two uploads racing each other).
 */
export async function spendCredit(
  userId: string,
  pageCount: number,
): Promise<number | null> {
  const rows = (await sql`
    WITH deducted AS (
      UPDATE users
      SET credits = credits - 1
      WHERE id = ${userId} AND credits > 0
      RETURNING id, credits
    )
    INSERT INTO usage_logs (user_id, page_count, status)
    SELECT id, ${pageCount}, 'success' FROM deducted
    RETURNING (SELECT credits FROM deducted) AS remaining
  `) as Array<{ remaining: number }>;

  return rows[0]?.remaining ?? null;
}

/**
 * Records a failed extraction. No credit is charged — a failure the user did
 * not cause should not cost them anything.
 */
export async function recordFailure(userId: string, pageCount: number): Promise<void> {
  await sql`
    INSERT INTO usage_logs (user_id, page_count, status)
    VALUES (${userId}, ${pageCount}, 'failed')
  `;
}
