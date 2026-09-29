import { NextRequest, NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const resolution = await getApiWorkspace();
  if (!resolution.context) return NextResponse.json({ error: resolution.error }, { status: resolution.status });
  const { workspace, supabase } = resolution.context;

  const { data: flow } = await supabase
    .from("flows")
    .select("id")
    .eq("id", flowId)
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (!flow) return NextResponse.json({ error: "Flow not found" }, { status: 404 });

  const { data: versions, error } = await supabase
    .from("flow_versions")
    .select("id, version, name, published_by, created_at")
    .eq("flow_id", flowId)
    .order("version", { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(versions || []);
}
