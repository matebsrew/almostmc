"use client";

import {
  ArrowRightLeft,
  Bell,
  Clock,
  FileText,
  GitBranch,
  Globe,
  Hourglass,
  ListOrdered,
  MessageCircleReply,
  MessageSquare,
  Search,
  Send,
  Shuffle,
  Sparkles,
  Tag,
  UserCheck,
  Zap,
} from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";

export interface PaletteItem {
  type: string;
  nodeType: string;
  label: string;
  description: string;
  icon: typeof Zap;
  actionType?: string;
}

export interface PaletteCategory {
  name: string;
  items: PaletteItem[];
}

export const paletteCategories: PaletteCategory[] = [
  {
    name: "Triggers",
    items: [
      {
        type: "trigger",
        nodeType: "trigger",
        label: "Keyword Trigger",
        description: "Start when a message or comment matches a rule",
        icon: Zap,
      },
    ],
  },
  {
    name: "Messages",
    items: [
      {
        type: "sendMessage",
        nodeType: "sendMessage",
        label: "Send Message",
        description: "Send text, media, buttons or quick replies",
        icon: MessageSquare,
      },
      {
        type: "action",
        nodeType: "privateReply",
        label: "Private Reply",
        description: "DM someone from an Instagram/Facebook comment",
        icon: Send,
        actionType: "privateReply",
      },
      {
        type: "action",
        nodeType: "commentReply",
        label: "Comment Reply",
        description: "Post a public reply to the triggering comment",
        icon: MessageCircleReply,
        actionType: "commentReply",
      },
      {
        type: "aiResponse",
        nodeType: "aiResponse",
        label: "AI Response",
        description: "Generate a reply with your configured AI provider",
        icon: Sparkles,
      },
    ],
  },
  {
    name: "Logic",
    items: [
      {
        type: "condition",
        nodeType: "condition",
        label: "Condition",
        description: "Branch the flow using contact or message data",
        icon: GitBranch,
      },
      {
        type: "delay",
        nodeType: "delay",
        label: "Delay",
        description: "Wait before continuing",
        icon: Clock,
      },
      {
        type: "action",
        nodeType: "abSplit",
        label: "A/B Split",
        description: "Split traffic across multiple paths",
        icon: Shuffle,
        actionType: "abSplit",
      },
      {
        type: "action",
        nodeType: "smartDelay",
        label: "Wait for Reply",
        description: "Pause until the person responds or a timeout expires",
        icon: Hourglass,
        actionType: "smartDelay",
      },
    ],
  },
  {
    name: "Actions",
    items: [
      {
        type: "action",
        nodeType: "addTag",
        label: "Add Tag",
        description: "Add a tag to the contact",
        icon: Tag,
        actionType: "addTag",
      },
      {
        type: "action",
        nodeType: "removeTag",
        label: "Remove Tag",
        description: "Remove a tag from the contact",
        icon: Tag,
        actionType: "removeTag",
      },
      {
        type: "action",
        nodeType: "setCustomField",
        label: "Set Field",
        description: "Save a value on the contact",
        icon: FileText,
        actionType: "setCustomField",
      },
      {
        type: "action",
        nodeType: "httpRequest",
        label: "HTTP Request",
        description: "Call an external API",
        icon: Globe,
        actionType: "httpRequest",
      },
      {
        type: "action",
        nodeType: "goToFlow",
        label: "Go To Flow",
        description: "Jump to another automation",
        icon: ArrowRightLeft,
        actionType: "goToFlow",
      },
      {
        type: "action",
        nodeType: "humanTakeover",
        label: "Human Takeover",
        description: "Pause automation and hand off to the inbox",
        icon: UserCheck,
        actionType: "humanTakeover",
      },
      {
        type: "action",
        nodeType: "subscribe",
        label: "Subscribe",
        description: "Mark the contact as subscribed",
        icon: Bell,
        actionType: "subscribe",
      },
      {
        type: "action",
        nodeType: "unsubscribe",
        label: "Unsubscribe",
        description: "Mark the contact as unsubscribed",
        icon: Bell,
        actionType: "unsubscribe",
      },
      {
        type: "action",
        nodeType: "enrollSequence",
        label: "Enroll Sequence",
        description: "Add the contact to a drip sequence",
        icon: ListOrdered,
        actionType: "enrollSequence",
      },
    ],
  },
];

function onDragStart(event: DragEvent, item: PaletteItem) {
  const data = JSON.stringify({
    type: item.type,
    nodeType: item.nodeType,
    actionType: item.actionType,
  });
  event.dataTransfer.setData("application/reactflow", data);
  event.dataTransfer.effectAllowed = "move";
}

export function NodePalette({
  onAdd,
}: {
  onAdd?: (item: PaletteItem) => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return paletteCategories;

    return paletteCategories
      .map((category) => ({
        ...category,
        items: category.items.filter((item) =>
          `${item.label} ${item.description}`
            .toLowerCase()
            .includes(normalized)
        ),
      }))
      .filter((category) => category.items.length > 0);
  }, [query]);

  return (
    <aside className="flex w-64 flex-col border-r border-border bg-card">
      <div className="border-b border-border p-3">
        <h2 className="text-sm font-semibold">Add a step</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Click to add or drag onto the canvas.
        </p>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search steps..."
            className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-xs outline-none transition focus:border-ring focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No step matches “{query}”.
          </div>
        ) : (
          filtered.map((category) => (
            <div key={category.name} className="mb-5">
              <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {category.name}
              </h3>
              <div className="space-y-1.5">
                {category.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.nodeType}
                      type="button"
                      draggable
                      onDragStart={(event) => onDragStart(event, item)}
                      onClick={() => onAdd?.(item)}
                      className="group flex w-full cursor-grab items-start gap-2.5 rounded-xl border border-border bg-background px-3 py-2.5 text-left transition hover:border-primary/40 hover:bg-accent active:cursor-grabbing"
                    >
                      <span className="mt-0.5 rounded-md bg-muted p-1.5 text-muted-foreground transition group-hover:text-foreground">
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-foreground">
                          {item.label}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
