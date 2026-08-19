/**
 * Shapes for the admin usage view.
 *
 * The queries that produce them live in ./dashboard, batched into a single
 * round trip — see the note there for why they are not three separate calls.
 */

export type UsageLogRow = {
  id: string;
  user_id: string;
  email: string;
  page_count: number;
  status: "success" | "failed";
  created_at: string;
};

export type UsageTotals = {
  successful: number;
  failed: number;
  pages: number;
};
