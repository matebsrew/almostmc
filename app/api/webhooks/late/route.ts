import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/types/database";
import crypto from "crypto";
import { getWebhookSecret } from "@/lib/security/workspace-secrets";

// ── Zernio API webhook payload ───────────────────────────────────────────────

interface WebhookPayload {
  id: string;
  event: string;
  message: {
    id: string;
    conversationId: string;
    platform: string;
    platformMessageId: string;
    direction: string;
    text: string | null;
    attachments: Array<{ type: string; url: string; payload?: string }>;
    sender: {
      id: string;
      name: string;
      username: string | null;
      picture: string | null;
    };
    sentAt: string;
    isRead: boolean;
  };
  conversation: {
    id: string;
    platformConversationId: string | null;
    participantId: string;
    participantName: string;
    participantUsername: string | null;
    participantPicture: string | null;
    status: string;
  };
  account: {
    id: string;
    platform: string;
    username: string;
    displayName: string;
  };
  metadata?: {
    quickReplyPayload?: string;
    callbackData?: string;
    postbackPayload?: string;
    postbackTitle?: string;
  };
  timestamp: string;
}

// ── Webhook handler ─────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    return await handleWebhook(request);
  } catch (err) {
    console.error("Webhook handler error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

async function handleWebhook(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 262_144) {
    return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
  }

  let body: string;
  try {
    body = await readBodyBounded(request, 262_144);
  } catch {
    return NextResponse.json({ error: "Request body is too large or invalid" }, { status: 413 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(body) as WebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload || typeof payload !== "object" || typeof payload.event !== "string") {
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  // The endpoint only processes inbound messages. Unsupported events have no side effects.
  if (payload.event !== "message.received") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { message: msg, conversation: conv, account } = payload;
  if (
    !msg || typeof msg.id !== "string" || msg.id.length > 255 ||
    !["inbound", "outbound"].includes(msg.direction) ||
    (msg.text !== null && typeof msg.text !== "string") ||
    !msg.sender || typeof msg.sender.id !== "string" || msg.sender.id.length > 512 ||
    !conv || typeof conv.id !== "string" || conv.id.length > 512 ||
    !account || typeof account.id !== "string" || account.id.length > 255
  ) {
    return NextResponse.json({ error: "Invalid message event" }, { status: 400 });
  }

  const eventId = typeof payload.id === "string" ? payload.id.trim() : "";
  const eventHeader = request.headers.get("x-zernio-event-id") ?? request.headers.get("x-late-event-id");
  if (!eventId || eventId.length > 255 || (eventHeader && eventHeader !== eventId)) {
    return NextResponse.json({ error: "Invalid webhook event id" }, { status: 400 });
  }

  const supabase = await createServiceClient();

  // Look up channel by late_account_id
  const { data: channel, error: channelError } = await supabase
    .from("channels")
    .select("id, workspace_id, platform, late_account_id")
    .eq("late_account_id", account.id)
    .eq("is_active", true)
    .single();

  if (channelError || !channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  const signature = request.headers.get("x-zernio-signature") ?? request.headers.get("x-late-signature");
  let webhookSecret: string | null;
  try {
    webhookSecret = await getWebhookSecret(channel.id, channel.workspace_id);
  } catch {
    return NextResponse.json({ error: "Webhook signature verification is unavailable" }, { status: 503 });
  }
  if (!webhookSecret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) {
    return NextResponse.json({ error: "Webhook signature is not valid" }, { status: 401 });
  }
  const expectedSignature = crypto.createHmac("sha256", webhookSecret).update(body).digest();
  const receivedSignature = Buffer.from(signature, "hex");
  if (receivedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(receivedSignature, expectedSignature)) {
    return NextResponse.json({ error: "Webhook signature is not valid" }, { status: 401 });
  }

  // Ignore signed outbound messages to prevent loops.
  if (msg.direction === "outbound") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { data: claimed, error: claimError } = await supabase.rpc("claim_webhook_event", {
    p_channel_id: channel.id,
    p_event_id: eventId,
    p_payload: payload as unknown as Json,
  });
  if (claimError) return NextResponse.json({ error: "Webhook event could not be claimed" }, { status: 503 });
  return NextResponse.json(
    { ok: true, duplicate: !claimed, queued: Boolean(claimed) },
    { status: 202 }
  );
}

async function readBodyBounded(request: NextRequest, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Body too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
