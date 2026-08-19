import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { getDashboard } from "@/lib/dashboard";
import { requireAdmin } from "@/lib/guards";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 200);
    const { logs, totals } = await getDashboard(Number.isFinite(limit) ? limit : 200);
    return NextResponse.json({ logs, totals });
  } catch (err) {
    return errorResponse("admin.usage.list", err);
  }
}
