import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

interface IncomingMessage {
  text?: string;
  postbackPayload?: string;
  quickReplyPayload?: string;
  sender?: { id: string };
}

type Trigger = Database["public"]["Tables"]["triggers"]["Row"];

export async function matchTrigger(
  supabase: SupabaseClient<Database>,
  channelId: string,
  conversationId: string,
  message: IncomingMessage
): Promise<Trigger | null> {
  // Get all active triggers for this channel (or global triggers with null channel_id)
  const { data: triggers } = await supabase
    .from("triggers")
    .select("*, flows!inner(status)")
    .or(`channel_id.eq.${channelId},channel_id.is.null`)
    .eq("is_active", true)
    .eq("flows.status", "published")
    .order("priority", { ascending: false });

  if (!triggers || triggers.length === 0) return null;

  // Priority order: postback > quick_reply > keyword > welcome > default
  // 1. Check postback triggers
  if (message.postbackPayload) {
    const match = triggers.find(
      (t) =>
        t.type === "postback" &&
        (t.config as { payload?: string })?.payload === message.postbackPayload
    );
    if (match) return match;
  }

  // 2. Check quick_reply triggers
  if (message.quickReplyPayload) {
    const match = triggers.find(
      (t) =>
        t.type === "quick_reply" &&
        (t.config as { payload?: string })?.payload ===
          message.quickReplyPayload
    );
    if (match) return match;
  }

  // 3. Check keyword triggers
  if (message.text) {
    const text = message.text.toLowerCase().trim();

    for (const trigger of triggers.filter((t) => t.type === "keyword")) {
      const config = trigger.config as {
        keywords?: Array<string | { value: string; matchType?: "exact" | "contains" | "startsWith" }>;
        matchType?: "exact" | "contains" | "startsWith";
      };

      if (!config.keywords) continue;

      for (const kw of config.keywords) {
        // Support both formats: plain string or { value, matchType } object
        const keyword = (typeof kw === "string" ? kw : kw.value).toLowerCase();
        const matchType =
          (typeof kw === "object" && kw.matchType) || config.matchType || "contains";

        if (matchType === "exact" && text === keyword) return trigger;
        if (matchType === "contains" && text.includes(keyword)) return trigger;
        if (matchType === "startsWith" && text.startsWith(keyword))
          return trigger;
      }
    }
  }

  // 4. Check welcome trigger (first inbound message for this contact on this channel)
  // Count inbound messages in this specific conversation. If this is the only one
  // (count === 1), it means the current message is the contact's very first message.
  const { count } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound");

  if (count === 1) {
    const welcomeTrigger = triggers.find((t) => t.type === "welcome");
    if (welcomeTrigger) return welcomeTrigger;
  }

  // 5. Default trigger
  const defaultTrigger = triggers.find((t) => t.type === "default");
  return defaultTrigger || null;
}


interface IncomingComment {
  text: string;
  /** Both Zernio's internal post id and the platform-native post id when available. */
  postIds: string[];
}

/**
 * Match a comment.received event against Growth Tools comment_keyword rules.
 * The workspace filter matters because global triggers have channel_id = null.
 */
export async function matchCommentTrigger(
  supabase: SupabaseClient<Database>,
  channelId: string,
  workspaceId: string,
  comment: IncomingComment
): Promise<Trigger | null> {
  const { data: triggers } = await supabase
    .from("triggers")
    .select("*, flows!inner(status, workspace_id)")
    .or(`channel_id.eq.${channelId},channel_id.is.null`)
    .eq("type", "comment_keyword")
    .eq("is_active", true)
    .eq("flows.status", "published")
    .eq("flows.workspace_id", workspaceId)
    .order("priority", { ascending: false });

  if (!triggers?.length) return null;

  const text = comment.text.toLowerCase().trim();
  const receivedPostIds = new Set(comment.postIds.filter(Boolean));

  for (const trigger of triggers) {
    const config = trigger.config as {
      keywords?: Array<
        string | {
          value: string;
          matchType?: "exact" | "contains" | "startsWith";
        }
      >;
      matchType?: "exact" | "contains" | "startsWith";
      postIds?: string[];
    };

    const restrictedPostIds = (config.postIds ?? []).filter(Boolean);
    if (
      restrictedPostIds.length > 0 &&
      !restrictedPostIds.some((postId) => receivedPostIds.has(postId))
    ) {
      continue;
    }

    for (const entry of config.keywords ?? []) {
      const keyword = (typeof entry === "string" ? entry : entry.value)
        .toLowerCase()
        .trim();
      if (!keyword) continue;

      const matchType =
        (typeof entry === "object" && entry.matchType) ||
        config.matchType ||
        "contains";

      if (matchType === "exact" && text === keyword) return trigger;
      if (matchType === "contains" && text.includes(keyword)) return trigger;
      if (matchType === "startsWith" && text.startsWith(keyword)) return trigger;
    }
  }

  return null;
}
