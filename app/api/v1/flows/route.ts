import { NextRequest, NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";

export async function GET() {
  const resolution = await getApiWorkspace();
  if (!resolution.context) return NextResponse.json({ error: resolution.error }, { status: resolution.status });
  const { workspace, supabase } = resolution.context;

  const { data: flows, error } = await supabase
    .from("flows")
    .select("id, name, description, status, version, published_at, created_at, updated_at")
    .eq("workspace_id", workspace.id)
    .order("updated_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(flows);
}

export async function POST(request: NextRequest) {
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
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid flow" }, { status: 400 });
  const values = body as Record<string, unknown>;
  const name = typeof values.name === "string" ? values.name.trim() : "Untitled Flow";
  if (!name || name.length > 120 || (values.nodes !== undefined && !Array.isArray(values.nodes)) || (values.edges !== undefined && !Array.isArray(values.edges))) {
    return NextResponse.json({ error: "Invalid flow" }, { status: 400 });
  }

  const { data: flow, error } = await supabase
    .from("flows")
    .insert({
      workspace_id: workspace.id,
      name,
      description: typeof values.description === "string" ? values.description.slice(0, 500) : null,
      nodes: Array.isArray(values.nodes) ? values.nodes : [],
      edges: Array.isArray(values.edges) ? values.edges : [],
    })
    .select("id, name, status")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(flow, { status: 201 });
}
