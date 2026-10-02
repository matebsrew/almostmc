import type { Edge, Node } from "@xyflow/react";

export interface FlowValidationIssue {
  nodeId?: string;
  message: string;
}

function hasMessageContent(data: Record<string, unknown>): boolean {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const value = message as Record<string, unknown>;
    return Boolean(
      (typeof value.text === "string" && value.text.trim()) ||
      (typeof value.imageUrl === "string" && value.imageUrl.trim()) ||
      (typeof value.mediaUrl === "string" && value.mediaUrl.trim()) ||
      value.carousel
    );
  });
}

export function validateFlow(
  nodes: Node[],
  edges: Edge[]
): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];

  if (nodes.length === 0) {
    return [{ message: "Add at least one trigger and one action before publishing." }];
  }

  const triggers = nodes.filter((node) => node.type === "trigger");
  if (triggers.length === 0) {
    issues.push({ message: "This flow needs a trigger." });
  }

  for (const node of nodes) {
    const data = node.data as Record<string, unknown>;

    if (node.type !== "trigger") {
      const reachable = edges.some((edge) => edge.target === node.id);
      if (!reachable) {
        issues.push({
          nodeId: node.id,
          message: "This step is not connected to the flow.",
        });
      }
    }

    if (node.type === "trigger") {
      const triggerType = String(data.triggerType || "keyword");
      const keywords = Array.isArray(data.keywords) ? data.keywords : [];
      if (
        (triggerType === "keyword" || triggerType === "comment_keyword") &&
        keywords.length === 0
      ) {
        issues.push({
          nodeId: node.id,
          message: "Add at least one keyword to this trigger.",
        });
      }
      if (!edges.some((edge) => edge.source === node.id)) {
        issues.push({
          nodeId: node.id,
          message: "Connect this trigger to a next step.",
        });
      }
    }

    if (node.type === "sendMessage" && !hasMessageContent(data)) {
      issues.push({
        nodeId: node.id,
        message: "Add content to this message.",
      });
    }

    if (node.type === "condition") {
      const conditions = Array.isArray(data.conditions) ? data.conditions : [];
      if (conditions.length === 0) {
        issues.push({
          nodeId: node.id,
          message: "Add at least one condition.",
        });
      }
    }

    if (node.type === "aiResponse") {
      const prompt =
        typeof data.systemPrompt === "string" ? data.systemPrompt.trim() : "";
      if (!prompt) {
        issues.push({
          nodeId: node.id,
          message: "Add instructions for the AI response.",
        });
      }
    }

    if (node.type === "action") {
      const actionType = String(data.actionType || "");

      if (
        (actionType === "addTag" || actionType === "removeTag") &&
        !(typeof data.tagName === "string" && data.tagName.trim())
      ) {
        issues.push({
          nodeId: node.id,
          message: "Choose a tag name.",
        });
      }

      if (
        actionType === "setCustomField" &&
        !(typeof data.fieldSlug === "string" && data.fieldSlug.trim())
      ) {
        issues.push({
          nodeId: node.id,
          message: "Choose which custom field to update.",
        });
      }

      if (
        actionType === "httpRequest" &&
        !(typeof data.url === "string" && data.url.trim())
      ) {
        issues.push({
          nodeId: node.id,
          message: "Add the HTTP request URL.",
        });
      }

      if (
        actionType === "goToFlow" &&
        !(typeof data.flowId === "string" && data.flowId.trim())
      ) {
        issues.push({
          nodeId: node.id,
          message: "Choose a destination flow.",
        });
      }

      if (
        (actionType === "privateReply" || actionType === "commentReply") &&
        !(typeof data.text === "string" && data.text.trim())
      ) {
        issues.push({
          nodeId: node.id,
          message:
            actionType === "privateReply"
              ? "Add the private reply message."
              : "Add the public comment reply.",
        });
      }

      if (actionType === "abSplit") {
        const paths = Array.isArray(data.paths)
          ? (data.paths as Array<{ weight?: number }>)
          : [];
        const total = paths.reduce(
          (sum, path) => sum + Number(path.weight || 0),
          0
        );
        if (paths.length < 2 || total !== 100) {
          issues.push({
            nodeId: node.id,
            message: "A/B split paths must add up to 100%.",
          });
        }
      }
    }
  }

  return issues;
}
