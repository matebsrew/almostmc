import { NextRequest, NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";
import { getWorkspaceSecrets } from "@/lib/security/workspace-secrets";
import { createZernioClient } from "@/lib/zernio-client";

function authFailure(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function GET(request: NextRequest) {
  const resolution = await getApiWorkspace();
  if (!resolution.context) return authFailure(resolution.status, resolution.error);
  const { workspace, supabase } = resolution.context;

  const conversationId = request.nextUrl.searchParams.get("conversationId");
  if (!conversationId || conversationId.length > 100) {
    return NextResponse.json({ error: "conversationId is invalid" }, { status: 400 });
  }

  const { data: conversation } = await supabase
    .from("conversations")
    .select("late_conversation_id, workspace_id, channels(late_account_id)")
    .eq("id", conversationId)
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (!conversation?.late_conversation_id) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const { lateApiKey } = await getWorkspaceSecrets(workspace.id);
  if (!lateApiKey) return NextResponse.json({ error: "API key not configured" }, { status: 400 });

  const channel = conversation.channels as { late_account_id: string } | null;
  if (!channel?.late_account_id) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  try {
    const zernio = createZernioClient(lateApiKey);
    const result = await zernio.messages.getInboxConversationMessages({
      path: { conversationId: conversation.late_conversation_id },
      query: { accountId: channel.late_account_id },
    });
    const sourceMessages = (result.data as { data?: unknown[] })?.data ?? [];
    const messages = sourceMessages.map((raw) => {
      const message = raw as Record<string, unknown>;
      return {
        id: message.id,
        conversation_id: conversationId,
        direction: message.direction === "outbound" ? "outbound" : "inbound",
        text: message.text ?? message.message ?? null,
        attachments: Array.isArray(message.attachments) ? message.attachments : null,
        quick_reply_payload: null,
        postback_payload: null,
        callback_data: null,
        platform_message_id: message.platformMessageId ?? null,
        sent_by_flow_id: null,
        sent_by_node_id: null,
        sent_by_user_id: null,
        status: "sent",
        created_at: message.sentAt ?? message.createdAt ?? new Date().toISOString(),
      };
    });
    return NextResponse.json(messages);
  } catch (error) {
    console.error("Failed to fetch messages from Zernio API:", error);
    return NextResponse.json({ error: "Failed to fetch messages" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const resolution = await getApiWorkspace();
  if (!resolution.context) return authFailure(resolution.status, resolution.error);
  const { workspace, supabase, user } = resolution.context;

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 12_288) {
    return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 12_288) return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const conversationId =
    body && typeof body === "object" && "conversationId" in body && typeof body.conversationId === "string"
      ? body.conversationId
      : "";
  const messageText =
    body && typeof body === "object" && "text" in body && typeof body.text === "string"
      ? body.text.trim()
      : "";
  if (!conversationId || conversationId.length > 100 || !messageText || messageText.length > 5000) {
    return NextResponse.json({ error: "conversationId and text are required" }, { status: 400 });
  }

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, workspace_id, late_conversation_id, channels(late_account_id)")
    .eq("id", conversationId)
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  if (!conversation.late_conversation_id) {
    return NextResponse.json({ error: "No Zernio conversation ID linked" }, { status: 400 });
  }
  const channel = conversation.channels as { late_account_id: string } | null;
  if (!channel?.late_account_id) return NextResponse.json({ error: "Channel not found" }, { status: 404 });

  const { lateApiKey } = await getWorkspaceSecrets(workspace.id);
  if (!lateApiKey) return NextResponse.json({ error: "API key not configured" }, { status: 400 });

  try {
    const zernio = createZernioClient(lateApiKey);
    const result = await zernio.messages.sendInboxMessage({
      path: { conversationId: conversation.late_conversation_id },
      body: { accountId: channel.late_account_id, message: messageText },
    });
    const messageId = (result.data as { data?: { messageId?: string } })?.data?.messageId ?? null;
    const createdAt = new Date().toISOString();

    await supabase
      .from("conversations")
      .update({ last_message_at: createdAt, last_message_preview: messageText.slice(0, 100) })
      .eq("id", conversationId)
      .eq("workspace_id", workspace.id);

    return NextResponse.json(
      {
        id: messageId ?? `sent-${Date.now()}`,
        conversation_id: conversationId,
        direction: "outbound",
        text: messageText,
        attachments: null,
        quick_reply_payload: null,
        postback_payload: null,
        callback_data: null,
        platform_message_id: messageId,
        sent_by_flow_id: null,
        sent_by_node_id: null,
        sent_by_user_id: user.id,
        status: "sent",
        created_at: createdAt,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Failed to send message via Zernio API:", error);
    return NextResponse.json({ error: "Failed to send message" }, { status: 502 });
  }
}
