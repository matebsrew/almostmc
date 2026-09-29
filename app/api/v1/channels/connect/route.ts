import { NextRequest, NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";
import { getWorkspaceSecrets } from "@/lib/security/workspace-secrets";
import { createZernioClient } from "@/lib/zernio-client";

export async function POST(request: NextRequest) {
  const resolution = await getApiWorkspace();
  if (!resolution.context) {
    return NextResponse.json(
      { error: resolution.error },
      { status: resolution.status }
    );
  }
  const { workspace, role } = resolution.context;
  if (role !== "owner" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { lateApiKey } = await getWorkspaceSecrets(workspace.id);
  if (!lateApiKey) {
    return NextResponse.json(
      { error: "Zernio API key not configured. Go to Settings first." },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const platform =
    body && typeof body === "object" && "platform" in body
      ? (body as { platform?: unknown }).platform
      : null;

  const supported = ["facebook", "instagram", "linkedin", "twitter", "telegram", "bluesky", "reddit"];
  if (typeof platform !== "string" || !supported.includes(platform)) {
    return NextResponse.json(
      { error: `Unsupported platform. Must be one of: ${supported.join(", ")}` },
      { status: 400 }
    );
  }

  const zernio = createZernioClient(lateApiKey);
  try {
    const profilesRes = await zernio.profiles.listProfiles();
    const profiles = profilesRes.data?.profiles ?? [];
    if (profiles.length === 0) {
      return NextResponse.json(
        { error: "No Zernio profiles found. Create one in your Zernio dashboard first." },
        { status: 400 }
      );
    }

    const profileId = profiles[0]._id;
    if (!profileId) {
      return NextResponse.json({ error: "Zernio profile is invalid" }, { status: 502 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) {
      return NextResponse.json({ error: "Application URL is not configured" }, { status: 500 });
    }
    const callbackUrl = new URL("/dashboard/channels/callback", appUrl).toString();
    const result = await zernio.connect.getConnectUrl({
      path: { platform },
      query: { profileId, redirect_url: callbackUrl },
    });

    if (!result.data?.authUrl) {
      return NextResponse.json({ error: "Failed to get connect URL" }, { status: 502 });
    }
    return NextResponse.json({ authUrl: result.data.authUrl });
  } catch (error) {
    console.error("Failed to get connect URL:", error);
    return NextResponse.json({ error: "Connection failed" }, { status: 502 });
  }
}
