import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/guards";
import { log } from "@/lib/log";
import { deleteUser, isLastAdmin, updateUser } from "@/lib/users";
import { updateUserSchema } from "@/lib/validation";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  let adminId: string | undefined;
  try {
    const admin = await requireAdmin();
    adminId = admin.id;
    const { id } = await params;

    const parsed = updateUserSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid input." },
        { status: 400 },
      );
    }

    // Demoting the only remaining admin would leave the instance with no way to
    // create or top up anyone, recoverable only by running create-admin against
    // the database by hand.
    if (parsed.data.role === "user" && (await isLastAdmin(id))) {
      return NextResponse.json(
        { error: "This is the only admin account. Promote another admin first." },
        { status: 409 },
      );
    }

    const user = await updateUser(id, parsed.data);
    if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });

    log({ event: "admin.users.update", status: "ok", userId: adminId });
    return NextResponse.json({ user });
  } catch (err) {
    return errorResponse("admin.users.update", err, adminId);
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  let adminId: string | undefined;
  try {
    const admin = await requireAdmin();
    adminId = admin.id;
    const { id } = await params;

    if (id === admin.id) {
      return NextResponse.json(
        { error: "You cannot delete your own account." },
        { status: 409 },
      );
    }
    if (await isLastAdmin(id)) {
      return NextResponse.json(
        { error: "This is the only admin account." },
        { status: 409 },
      );
    }

    // ON DELETE CASCADE takes the usage_logs rows with it, so removing an
    // account also removes the record of how much they used it.
    const removed = await deleteUser(id);
    if (!removed) return NextResponse.json({ error: "User not found." }, { status: 404 });

    log({ event: "admin.users.delete", status: "ok", userId: adminId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse("admin.users.delete", err, adminId);
  }
}
