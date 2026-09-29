import { NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";

const CHANNEL_FIELDS =
  "id, workspace_id, platform, late_account_id, username, display_name, profile_picture, is_active, created_at, updated_at";

export async function GET() {
  const resolution = await getApiWorkspace();
  if (!resolution.context) {
    return NextResponse.json(
      { error: resolution.error },
      { status: resolution.status }
    );
  }

  const { workspace, supabase } = resolution.context;
  const { data: channels, error } = await supabase
    .from("channels")
    .select(CHANNEL_FIELDS)
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(channels);
}
