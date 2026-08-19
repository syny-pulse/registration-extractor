/**
 * Seeds an admin account. This is the only way an admin comes into existence —
 * there is no self-signup path and no way to promote yourself through the UI
 * without already being one.
 *
 *   npm run create-admin -- you@example.com
 *
 * The password is generated and printed once. Nothing stores it in plaintext,
 * so if it scrolls away, re-run with --reset to issue a new one.
 */
import { randomBytes } from "node:crypto";

import "./env.mjs";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
const reset = args.includes("--reset");

if (!email || !email.includes("@")) {
  console.error("Usage: npm run create-admin -- you@example.com [--reset]");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// 18 bytes of base64url: ~144 bits, no ambiguous-character problems when it is
// read off a screen and typed somewhere else.
const password = randomBytes(18).toString("base64url");
const hash = await bcrypt.hash(password, 12);

const existing = await sql`SELECT id, role FROM users WHERE email = ${email}`;

if (existing.length > 0 && !reset) {
  console.error(`\n${email} already exists. Re-run with --reset to issue a new password.`);
  process.exit(1);
}

if (existing.length > 0) {
  await sql`
    UPDATE users SET password_hash = ${hash}, role = 'admin' WHERE email = ${email}
  `;
  console.log(`\nReset the password for ${email} and confirmed admin role.`);
} else {
  await sql`
    INSERT INTO users (email, password_hash, role, credits)
    VALUES (${email}, ${hash}, 'admin', 100)
  `;
  console.log(`\nCreated admin ${email} with 100 credits.`);
}

console.log(`\n  Password: ${password}\n`);
console.log("Shown once. Sign in at /login and change it from the admin screen.");
