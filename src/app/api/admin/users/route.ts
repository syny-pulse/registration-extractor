import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { getDashboard } from "@/lib/dashboard";
import { requireAdmin } from "@/lib/guards";
import { log } from "@/lib/log";
import { createUser } from "@/lib/users";
import { createUserSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    const { users } = await getDashboard();
    return NextResponse.json({ users });
  } catch (err) {
    return errorResponse("admin.users.list", err);
  }
}

export async function POST(request: Request) {
  let adminId: string | undefined;
  try {
    const admin = await requireAdmin();
    adminId = admin.id;

    const parsed = createUserSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid input." },
        { status: 400 },
      );
    }

    const user = await createUser(parsed.data);
    log({ event: "admin.users.create", status: "ok", userId: adminId });
    return NextResponse.json({ user }, { status: 201 });
  } catch (err) {
    // Postgres unique_violation — the only failure here worth naming, and it
    // reveals nothing an admin cannot already see on the user list.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "An account with that email already exists." },
        { status: 409 },
      );
    }
    return errorResponse("admin.users.create", err, adminId);
  }
}
