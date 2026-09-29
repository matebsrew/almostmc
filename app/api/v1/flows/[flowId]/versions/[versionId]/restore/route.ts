import { NextRequest, NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ flowId: string; versionId: string }> }
) {
  const { flowId, versionId } = await params;
  const resolution = await getApiWorkspace();
  if (!resolution.context) return NextResponse.json({ error: resolution.error }, { status: resolution.status });
  const { workspace, supabase, role } = resolution.context;
  if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: flow } = await supabase
    .from("flows")
    .select("id")
    .eq("id", flowId)
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (!flow) return NextResponse.json({ error: "Flow not found" }, { status: 404 });

  const { data: version, error: versionError } = await supabase
    .from("flow_versions")
    .select("nodes, edges, viewport")
    .eq("id", versionId)
    .eq("flow_id", flowId)
    .maybeSingle();
  if (versionError || !version) return NextResponse.json({ error: "Version not found" }, { status: 404 });

  const { data: updated, error } = await supabase
    .from("flows")
    .update({
      nodes: version.nodes,
      edges: version.edges,
      viewport: version.viewport,
      status: "draft",
      updated_at: new Date().toISOString(),
    })
    .eq("id", flowId)
    .eq("workspace_id", workspace.id)
    .select("id")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Flow not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
