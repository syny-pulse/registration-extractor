import { handlers } from "@/auth";

// bcrypt and the Neon driver are Node-only, so this cannot run on the edge.
export const runtime = "nodejs";

export const { GET, POST } = handlers;
