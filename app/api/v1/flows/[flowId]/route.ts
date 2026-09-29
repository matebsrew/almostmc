import { NextRequest, NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";

type RouteContext = { params: Promise<{ flowId: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { flowId } = await params;
  const resolution = await getApiWorkspace();
  if (!resolution.context) return NextResponse.json({ error: resolution.error }, { status: resolution.status });
  const { workspace, supabase } = resolution.context;

  const { data: flow, error } = await supabase
    .from("flows")
    .select("*, triggers(*)")
    .eq("id", flowId)
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (error || !flow) return NextResponse.json({ error: "Flow not found" }, { status: 404 });
  return NextResponse.json(flow);
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { flowId } = await params;
  const resolution = await getApiWorkspace();
  if (!resolution.context) return NextResponse.json({ error: resolution.error }, { status: resolution.status });
  const { workspace, supabase, role } = resolution.context;
  if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 1_048_576) return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid flow update" }, { status: 400 });
  const values = body as Record<string, unknown>;
  if (
    (values.name !== undefined && (typeof values.name !== "string" || !values.name.trim() || values.name.length > 120)) ||
    (values.description !== undefined && values.description !== null && (typeof values.description !== "string" || values.description.length > 500)) ||
    (values.nodes !== undefined && !Array.isArray(values.nodes)) ||
    (values.edges !== undefined && !Array.isArray(values.edges))
  ) return NextResponse.json({ error: "Invalid flow update" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (values.name !== undefined) update.name = (values.name as string).trim();
  if (values.description !== undefined) update.description = values.description;
  if (values.nodes !== undefined) update.nodes = values.nodes;
  if (values.edges !== undefined) update.edges = values.edges;
  if (values.viewport !== undefined) update.viewport = values.viewport;
  if (Object.keys(update).length === 0) return NextResponse.json({ error: "No changes supplied" }, { status: 400 });

  const { data: flow, error } = await supabase
    .from("flows")
    .update(update)
    .eq("id", flowId)
    .eq("workspace_id", workspace.id)
    .select("id, name, status, updated_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!flow) return NextResponse.json({ error: "Flow not found" }, { status: 404 });
  return NextResponse.json(flow);
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const { flowId } = await params;
  const resolution = await getApiWorkspace();
  if (!resolution.context) return NextResponse.json({ error: resolution.error }, { status: resolution.status });
  const { workspace, supabase, role } = resolution.context;
  if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("flows")
    .delete()
    .eq("id", flowId)
    .eq("workspace_id", workspace.id)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Flow not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
