/**
 * Applies db/schema.sql to the database in DATABASE_URL.
 *
 * The schema is idempotent (every statement is IF NOT EXISTS), so re-running
 * this is safe. There is no migration tool here on purpose: two tables that
 * are meant to stay small do not need one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import "./env.mjs";
import { neon } from "@neondatabase/serverless";

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local first.");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const schema = readFileSync(join(here, "..", "db", "schema.sql"), "utf8");

// The HTTP driver sends one statement per request, so the file is split rather
// than sent whole. Comment lines are stripped first so a trailing `--` comment
// cannot swallow the following statement.
const statements = schema
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

for (const statement of statements) {
  const label = statement.split("\n")[0].slice(0, 60);
  process.stdout.write(`  ${label}... `);
  await sql.query(statement);
  console.log("ok");
}

console.log(`\nApplied ${statements.length} statements.`);
console.log("Next: npm run create-admin");
