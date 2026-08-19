/**
 * Checks that everything the app needs is actually reachable.
 *
 * Run this after each setup step rather than discovering three misconfigurations
 * at once through a failed upload.
 *
 *   npm run check
 */
import "./env.mjs";

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
}

// ---------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------
const required = ["AUTH_SECRET", "DATABASE_URL", "GEMINI_API_KEY"];
for (const key of required) {
  const value = process.env[key];
  record(`env ${key}`, Boolean(value), value ? "set" : "missing — see .env.example");
}

if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length < 32) {
  record("AUTH_SECRET strength", false, "shorter than 32 chars — generate a new one");
}

// ---------------------------------------------------------------------------
// 2. Database
// ---------------------------------------------------------------------------
if (process.env.DATABASE_URL) {
  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(process.env.DATABASE_URL);

    const version = await sql`SELECT version()`;
    record("database reachable", true, version[0].version.split(" ").slice(0, 2).join(" "));

    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `;
    const names = tables.map((t) => t.table_name);
    const hasSchema = names.includes("users") && names.includes("usage_logs");
    record(
      "schema applied",
      hasSchema,
      hasSchema ? names.join(", ") : "run: npm run init-db",
    );

    if (hasSchema) {
      const admins = await sql`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'`;
      record(
        "admin account exists",
        admins[0].n > 0,
        admins[0].n > 0
          ? `${admins[0].n} admin(s)`
          : "run: npm run create-admin -- you@example.com",
      );
    }
  } catch (err) {
    record("database reachable", false, err.message.split("\n")[0]);
  }
}

// ---------------------------------------------------------------------------
// 3. Gemini
// ---------------------------------------------------------------------------
if (process.env.GEMINI_API_KEY) {
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const model = process.env.GEMINI_MODEL ?? "gemini-3.7-flash";

    // Deliberately tiny — this is a reachability check, not a benchmark.
    const response = await ai.models.generateContent({
      model,
      contents: "Reply with the single word: ok",
      config: { maxOutputTokens: 2000, temperature: 0 },
    });

    record("gemini reachable", true, `${model} responded`);
    void response.text;
  } catch (err) {
    const message = err?.message ?? String(err);
    let hint = message.split("\n")[0].slice(0, 140);
    if (/API key not valid|API_KEY_INVALID/i.test(message)) {
      hint = "key rejected — check it was copied whole from aistudio.google.com/apikey";
    } else if (/not found|NOT_FOUND/i.test(message)) {
      hint = `model "${process.env.GEMINI_MODEL}" not available to this key — try gemini-3.7-flash`;
    } else if (/quota|RESOURCE_EXHAUSTED|429/i.test(message)) {
      hint = "quota exhausted — the project is likely still on the free tier";
    }
    record("gemini reachable", false, hint);
  }
}

// ---------------------------------------------------------------------------
// 4. The tier flag — a statement of fact that only a person can make
// ---------------------------------------------------------------------------
const paid = process.env.GEMINI_PAID_TIER_CONFIRMED === "true";
results.push({
  name: "paid tier confirmed",
  ok: true,
  detail: paid
    ? "yes — /privacy states paid-tier terms"
    : "NO — /privacy warns users not to upload real sheets (correct until billing is on)",
});

// ---------------------------------------------------------------------------
console.log("");
for (const { name, ok, detail } of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(24)} ${detail ?? ""}`);
}
console.log("");

if (failed > 0) {
  console.log(`${failed} check(s) failed.\n`);
  process.exit(1);
}

console.log("All checks passed.\n");
if (!paid) {
  console.log("Reminder: synthetic test sheets only until the project is on the paid tier.\n");
}
