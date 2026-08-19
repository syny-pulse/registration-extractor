import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These exercise the real functions in src/lib/users.ts against a real
 * Postgres — PGlite is Postgres 18 compiled to WASM, so constraints, CTEs and
 * FILTER clauses behave exactly as they will on Neon.
 *
 * The point is the credit deduction. It is written as a single statement
 * because Neon's HTTP driver has no interactive transactions, and "one
 * statement" is only a safe substitute for a transaction if it genuinely
 * behaves atomically. That is worth proving rather than assuming.
 */
vi.mock("@/lib/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();

  // Neon's tagged template resolves to the rows array; PGlite's resolves to a
  // result object. This shim makes PGlite look like Neon so the code under test
  // is the shipped code, unmodified.
  const sql = (strings: TemplateStringsArray, ...params: unknown[]) =>
    db.sql(strings, ...params).then((result) => result.rows);

  // Neon batches these into one HTTP request; PGlite has no HTTP to save, so
  // the shim just collects the queries the builder declares and runs them in
  // order, returning one rows array per query — the same shape callers see.
  const batch = async (
    build: (q: (s: TemplateStringsArray, ...p: unknown[]) => unknown) => unknown[],
  ) => {
    const collected: Array<{ strings: TemplateStringsArray; params: unknown[] }> = [];
    build((strings, ...params) => {
      const descriptor = { strings, params };
      collected.push(descriptor);
      return descriptor;
    });

    const results = [];
    for (const { strings, params } of collected) {
      results.push((await db.sql(strings, ...params)).rows);
    }
    return results;
  };

  return { sql, batch, __db: db };
});

const { sql, __db } = (await import("@/lib/db")) as unknown as {
  sql: (s: TemplateStringsArray, ...p: unknown[]) => Promise<unknown[]>;
  __db: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
};

const {
  createUser,
  deleteUser,
  getUserById,
  isLastAdmin,
  recordFailure,
  spendCredit,
  updateUser,
  verifyCredentials,
} = await import("@/lib/users");

const { getDashboard } = await import("@/lib/dashboard");

const schema = readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8");

beforeEach(async () => {
  await __db.query("DROP TABLE IF EXISTS usage_logs");
  await __db.query("DROP TABLE IF EXISTS users");

  // The very same file init-db.mjs applies, split the same way.
  const statements = schema
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) await __db.query(statement);
});

async function makeUser(credits = 3) {
  return createUser({
    email: "user@example.com",
    password: "correct-horse-battery",
    role: "user",
    credits,
  });
}

async function logsFor(userId: string) {
  return (await sql`
    SELECT status, page_count FROM usage_logs WHERE user_id = ${userId}
  `) as Array<{ status: string; page_count: number }>;
}

describe("schema", () => {
  it("applies cleanly from db/schema.sql", async () => {
    const tables = (await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `) as Array<{ table_name: string }>;
    expect(tables.map((t) => t.table_name)).toEqual(["usage_logs", "users"]);
  });

  it("has no column anywhere that could hold document content", async () => {
    const columns = (await sql`
      SELECT table_name || '.' || column_name AS col
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY col
    `) as Array<{ col: string }>;

    // The retention guarantee is meant to be structural rather than promised.
    // If someone later adds a filename, a notes field, or an extracted-data
    // column, this is the test that notices.
    expect(columns.map((c) => c.col)).toEqual([
      "usage_logs.created_at",
      "usage_logs.id",
      "usage_logs.page_count",
      "usage_logs.status",
      "usage_logs.user_id",
      "users.created_at",
      "users.credits",
      "users.email",
      "users.id",
      "users.password_hash",
      "users.role",
    ]);
  });

  it("refuses a negative balance at the database level", async () => {
    const user = await makeUser(0);
    await expect(
      __db.query("UPDATE users SET credits = -1 WHERE id = $1", [user.id]),
    ).rejects.toThrow();
  });
});

describe("accounts", () => {
  it("stores a hash, never the password", async () => {
    const user = await makeUser();
    const rows = (await sql`
      SELECT password_hash FROM users WHERE id = ${user.id}
    `) as Array<{ password_hash: string }>;
    expect(rows[0].password_hash).not.toContain("correct-horse");
    expect(rows[0].password_hash.startsWith("$2")).toBe(true);
  });

  it("accepts the right password and rejects the wrong one", async () => {
    await makeUser();
    await expect(
      verifyCredentials("user@example.com", "correct-horse-battery"),
    ).resolves.toMatchObject({ email: "user@example.com", role: "user" });
    await expect(verifyCredentials("user@example.com", "wrong")).resolves.toBeNull();
  });

  it("treats email as case-insensitive on both sides", async () => {
    await createUser({
      email: "Mixed.Case@Example.COM",
      password: "correct-horse-battery",
      role: "user",
      credits: 1,
    });
    await expect(
      verifyCredentials("mixed.case@example.com", "correct-horse-battery"),
    ).resolves.not.toBeNull();
  });

  it("returns null for an account that does not exist", async () => {
    await expect(verifyCredentials("nobody@example.com", "anything")).resolves.toBeNull();
  });

  it("rejects a duplicate email", async () => {
    await makeUser();
    await expect(makeUser()).rejects.toThrow();
  });

  it("recognises the last remaining admin", async () => {
    const admin = await createUser({
      email: "admin@example.com",
      password: "correct-horse-battery",
      role: "admin",
      credits: 0,
    });
    expect(await isLastAdmin(admin.id)).toBe(true);

    const second = await createUser({
      email: "admin2@example.com",
      password: "correct-horse-battery",
      role: "admin",
      credits: 0,
    });
    expect(await isLastAdmin(admin.id)).toBe(false);
    expect(await isLastAdmin(second.id)).toBe(false);
  });

  it("takes the usage history with the account when it is deleted", async () => {
    const user = await makeUser();
    await spendCredit(user.id, 2);
    expect(await deleteUser(user.id)).toBe(true);
    const remaining = await sql`SELECT id FROM usage_logs`;
    expect(remaining).toHaveLength(0);
  });

  it("updates credits and role independently", async () => {
    const user = await makeUser(1);
    await updateUser(user.id, { credits: 42 });
    expect((await getUserById(user.id))?.credits).toBe(42);
    await updateUser(user.id, { role: "admin" });
    const after = await getUserById(user.id);
    expect(after).toMatchObject({ role: "admin", credits: 42 });
  });
});

describe("credits", () => {
  it("charges exactly one credit and writes exactly one log row", async () => {
    const user = await makeUser(3);

    expect(await spendCredit(user.id, 4)).toBe(2);

    expect((await getUserById(user.id))?.credits).toBe(2);
    expect(await logsFor(user.id)).toEqual([{ status: "success", page_count: 4 }]);
  });

  it("refuses to charge an empty balance, and writes no log row", async () => {
    const user = await makeUser(0);

    expect(await spendCredit(user.id, 3)).toBeNull();

    expect((await getUserById(user.id))?.credits).toBe(0);
    expect(await logsFor(user.id)).toHaveLength(0);
  });

  it("never goes below zero, however many times it is called", async () => {
    const user = await makeUser(2);
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await spendCredit(user.id, 1));

    expect(results).toEqual([1, 0, null, null, null]);
    expect((await getUserById(user.id))?.credits).toBe(0);
    // Three refusals means three attempts that wrote nothing.
    expect(await logsFor(user.id)).toHaveLength(2);
  });

  it("keeps the deduction and the log row in lockstep under concurrency", async () => {
    const user = await makeUser(3);

    // Ten simultaneous attempts against three credits. Whatever the
    // interleaving, the invariant must hold: successes == log rows, and the
    // balance lands at zero rather than anywhere negative.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => spendCredit(user.id, 1)),
    );

    const successes = results.filter((r) => r !== null).length;
    expect(successes).toBe(3);
    expect(await logsFor(user.id)).toHaveLength(3);
    expect((await getUserById(user.id))?.credits).toBe(0);
  });

  it("records a failure without charging for it", async () => {
    const user = await makeUser(2);

    await recordFailure(user.id, 6);

    expect((await getUserById(user.id))?.credits).toBe(2);
    expect(await logsFor(user.id)).toEqual([{ status: "failed", page_count: 6 }]);
  });
});

describe("admin dashboard", () => {
  it("counts successes and failures separately per account", async () => {
    const user = await makeUser(5);
    await spendCredit(user.id, 1);
    await spendCredit(user.id, 2);
    await recordFailure(user.id, 3);

    const { users } = await getDashboard();
    expect(users[0]).toMatchObject({
      email: "user@example.com",
      credits: 3,
      successful_extractions: 2,
      failed_extractions: 1,
    });
    expect(users[0].last_used_at).not.toBeNull();
  });

  it("reports zero rather than null for an account that has never run one", async () => {
    await makeUser();
    const { users } = await getDashboard();
    expect(users[0].successful_extractions).toBe(0);
    expect(users[0].failed_extractions).toBe(0);
    expect(users[0].last_used_at).toBeNull();
  });

  it("returns users, logs and totals together from one batch", async () => {
    const user = await makeUser(5);
    await spendCredit(user.id, 4);
    await spendCredit(user.id, 2);
    await recordFailure(user.id, 7);

    const { users, logs, totals } = await getDashboard();

    expect(users).toHaveLength(1);
    expect(logs).toHaveLength(3);
    // Totals count only successful extractions' pages: 4 + 2, not the failed 7.
    expect(totals).toEqual({ successful: 2, failed: 1, pages: 6 });
  });

  it("honours the log limit without affecting the totals", async () => {
    const user = await makeUser(5);
    await spendCredit(user.id, 1);
    await spendCredit(user.id, 1);
    await spendCredit(user.id, 1);

    const { logs, totals } = await getDashboard(2);
    expect(logs).toHaveLength(2);
    expect(totals.successful).toBe(3);
  });
});
