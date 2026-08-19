import { batch } from "./db";
import type { UserWithUsage } from "./users";
import type { UsageLogRow, UsageTotals } from "./usage";

export type Dashboard = {
  users: UserWithUsage[];
  logs: UsageLogRow[];
  totals: UsageTotals;
};

/**
 * Everything the admin screen needs, in one HTTPS round trip.
 *
 * These were three parallel `sql` calls, which on a fast local link is fine and
 * on a long one is three separate TLS handshakes racing a 10-second connect
 * timeout. Any single one losing that race took down the whole page render.
 * Batching them makes it one connection, and as a bonus the three results are a
 * consistent snapshot rather than three reads taken moments apart.
 */
export async function getDashboard(logLimit = 200): Promise<Dashboard> {
  const limit = Math.min(Math.max(logLimit, 1), 1000);

  const [users, logs, totals] = await batch((q) => [
    q`
      SELECT
        u.id,
        u.email,
        u.role,
        u.credits,
        u.created_at,
        COUNT(l.id) FILTER (WHERE l.status = 'success')::int AS successful_extractions,
        COUNT(l.id) FILTER (WHERE l.status = 'failed')::int  AS failed_extractions,
        MAX(l.created_at) AS last_used_at
      FROM users u
      LEFT JOIN usage_logs l ON l.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `,
    q`
      SELECT l.id::text, l.user_id, u.email, l.page_count, l.status, l.created_at
      FROM usage_logs l
      JOIN users u ON u.id = l.user_id
      ORDER BY l.created_at DESC
      LIMIT ${limit}
    `,
    q`
      SELECT
        COUNT(*) FILTER (WHERE status = 'success')::int AS successful,
        COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed,
        COALESCE(SUM(page_count) FILTER (WHERE status = 'success'), 0)::int AS pages
      FROM usage_logs
    `,
  ]);

  return {
    users: users as unknown as UserWithUsage[],
    logs: logs as unknown as UsageLogRow[],
    totals: totals[0] as unknown as UsageTotals,
  };
}
