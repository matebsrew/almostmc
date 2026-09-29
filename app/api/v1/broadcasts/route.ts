import { NextRequest, NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";

export async function GET() {
  const resolution = await getApiWorkspace();
  if (!resolution.context) return NextResponse.json({ error: resolution.error }, { status: resolution.status });
  const { workspace, supabase } = resolution.context;

  const { data: broadcasts, error } = await supabase
    .from("broadcasts")
    .select("*")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(broadcasts);
}

export async function POST(request: NextRequest) {
  const resolution = await getApiWorkspace();
  if (!resolution.context) return NextResponse.json({ error: resolution.error }, { status: resolution.status });
  const { workspace, supabase, role } = resolution.context;
  if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 65_536) return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid broadcast" }, { status: 400 });
  const values = body as Record<string, unknown>;
  const name = typeof values.name === "string" ? values.name.trim() : "Untitled Broadcast";
  if (!name || name.length > 120) return NextResponse.json({ error: "Invalid broadcast name" }, { status: 400 });
  const messageContent = values.messageContent && typeof values.messageContent === "object"
    ? values.messageContent
    : {};
  const segmentFilter = values.segmentFilter && typeof values.segmentFilter === "object"
    ? values.segmentFilter
    : null;
  const scheduledFor = typeof values.scheduledFor === "string" && Number.isFinite(Date.parse(values.scheduledFor))
    ? new Date(values.scheduledFor).toISOString()
    : null;

  const { data: broadcast, error } = await supabase
    .from("broadcasts")
    .insert({
      workspace_id: workspace.id,
      name,
      message_content: messageContent as never,
      segment_filter: segmentFilter as never,
      scheduled_for: scheduledFor,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(broadcast, { status: 201 });
}
