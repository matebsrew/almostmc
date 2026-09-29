import { NextRequest, NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";

export async function GET(request: NextRequest) {
  const resolution = await getApiWorkspace();
  if (!resolution.context) {
    return NextResponse.json({ error: resolution.error }, { status: resolution.status });
  }
  const { workspace, supabase } = resolution.context;

  const searchParams = request.nextUrl.searchParams;
  const rawSearch = searchParams.get("search");
  const search = rawSearch?.slice(0, 100).replace(/[(),.%_*\\]/g, "");
  const tag = searchParams.get("tag")?.slice(0, 100);
  const subscribed = searchParams.get("subscribed");
  const requestedLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
  const requestedOffset = Number.parseInt(searchParams.get("offset") || "0", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const offset = Number.isFinite(requestedOffset) ? Math.min(Math.max(requestedOffset, 0), 1_000_000) : 0;

  let query = supabase
    .from("contacts")
    .select("*, contact_tags(tag_id, tags(id, name, color)), contact_channels(platform_sender_id, channel_id, channels(platform))", { count: "exact" })
    .eq("workspace_id", workspace.id)
    .order("last_interaction_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`display_name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  if (subscribed === "true") {
    query = query.eq("is_subscribed", true);
  } else if (subscribed === "false") {
    query = query.eq("is_subscribed", false);
  }

  const { data: contacts, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Filter by tag in-memory (Supabase doesn't easily filter through join)
  let filtered = contacts || [];
  if (tag) {
    filtered = filtered.filter((c) =>
      (c.contact_tags as Array<{ tags: { name: string } | null }>)?.some(
        (ct) => ct.tags?.name === tag
      )
    );
  }

  return NextResponse.json({ contacts: filtered, total: count });
}
