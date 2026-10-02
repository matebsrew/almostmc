"use client";

import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  History,
  Loader2,
  Play,
  Plus,
  Rocket,
  Save,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { Database, Json } from "@/lib/types/database";

import {
  NodePalette,
  type PaletteItem,
} from "./node-palette";
import { AddStepMenu } from "./add-step-menu";
import { validateFlow, type FlowValidationIssue } from "./flow-validation";
import { TriggerNode } from "./nodes/trigger-node";
import { SendMessageNode } from "./nodes/send-message-node";
import { ConditionNode } from "./nodes/condition-node";
import { DelayNode } from "./nodes/delay-node";
import { ActionNode } from "./nodes/action-node";
import { AiResponseNode } from "./nodes/AiResponseNode";
import { NodeConfigSidebar } from "./panels/NodeConfigSidebar";
import { VersionHistoryPanel } from "./panels/VersionHistoryPanel";
import { TestPanel } from "./panels/TestPanel";

type Flow = Database["public"]["Tables"]["flows"]["Row"];

const nodeTypes: NodeTypes = {
  trigger: TriggerNode,
  sendMessage: SendMessageNode,
  condition: ConditionNode,
  delay: DelayNode,
  action: ActionNode,
  aiResponse: AiResponseNode,
};

interface FlowCanvasProps {
  flow: Flow;
}

let nodeId = 0;

function getNodeId() {
  return `node_${Date.now()}_${nodeId++}`;
}

function getDefaultData(
  type: string,
  actionType?: string
): Record<string, unknown> {
  switch (type) {
    case "trigger":
      return { triggerType: "keyword", keywords: [] };
    case "sendMessage":
      return { messages: [{ text: "" }] };
    case "condition":
      return { conditions: [], logic: "and" };
    case "delay":
      return { duration: 5, unit: "minutes" };
    case "aiResponse":
      return {
        systemPrompt: "",
        model: "openai/gpt-4o-mini",
        temperature: 0.7,
        maxTokens: 500,
        contextMessages: 10,
      };
    case "action":
      return {
        actionType: actionType || "addTag",
        ...(actionType === "commentReply" || actionType === "privateReply"
          ? { text: "" }
          : {}),
        ...(actionType === "abSplit"
          ? {
              paths: [
                { name: "A", weight: 50 },
                { name: "B", weight: 50 },
              ],
            }
          : {}),
      };
    default:
      return {};
  }
}

function getPersistableNodes(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    const {
      selected: _selected,
      dragging: _dragging,
      measured: _measured,
      ...persistable
    } = node;
    return persistable as Node;
  });
}

function FlowCanvasInner({ flow }: FlowCanvasProps) {
  const router = useRouter();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const changeVersionRef = useRef(0);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const supabase = useMemo(() => createClient(), []);

  const initialNodes: Node[] = Array.isArray(flow.nodes)
    ? (flow.nodes as unknown as Node[])
    : [];
  const initialEdges: Edge[] = Array.isArray(flow.edges)
    ? (flow.edges as unknown as Edge[])
    : [];

  const [nodes, setNodes, applyNodeChanges] = useNodesState(initialNodes);
  const [edges, setEdges, applyEdgeChanges] = useEdgesState(initialEdges);
  const [flowName, setFlowName] = useState(flow.name);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [versionPanelOpen, setVersionPanelOpen] = useState(false);
  const [testPanelOpen, setTestPanelOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [publishIssues, setPublishIssues] = useState<FlowValidationIssue[]>([]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addAfterNodeId, setAddAfterNodeId] = useState<string | null>(null);

  const validationIssues = useMemo(
    () => validateFlow(nodes, edges),
    [nodes, edges]
  );

  const selectedNode = selectedNodeId
    ? nodes.find((node) => node.id === selectedNodeId) || null
    : null;

  const markDirty = useCallback(() => {
    changeVersionRef.current += 1;
    setDirty(true);
  }, []);

  const createNode = useCallback(
    (
      item: Pick<PaletteItem, "type" | "nodeType" | "actionType">,
      position: { x: number; y: number }
    ): Node => ({
      id: getNodeId(),
      type: item.type,
      position,
      data: getDefaultData(item.type, item.actionType || item.nodeType),
    }),
    []
  );

  const addNodeAtCanvasCenter = useCallback(
    (item: PaletteItem) => {
      const rect = reactFlowWrapper.current?.getBoundingClientRect();
      const position = rect
        ? screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          })
        : { x: 120, y: 120 };

      const node = createNode(item, position);
      setNodes((current) => [...current, node]);
      setSelectedNodeId(node.id);
      setVersionPanelOpen(false);
      setTestPanelOpen(false);
      markDirty();
    },
    [createNode, markDirty, screenToFlowPosition, setNodes]
  );

  const openAddNext = useCallback((nodeId: string) => {
    setAddAfterNodeId(nodeId);
    setAddMenuOpen(true);
  }, []);

  const handleQuickAdd = useCallback(
    (item: PaletteItem) => {
      if (!addAfterNodeId) {
        addNodeAtCanvasCenter(item);
        setAddMenuOpen(false);
        return;
      }

      const parent = nodes.find((node) => node.id === addAfterNodeId);
      if (!parent) {
        setAddMenuOpen(false);
        setAddAfterNodeId(null);
        return;
      }

      const node = createNode(item, {
        x: parent.position.x,
        y: parent.position.y + 220,
      });

      setNodes((current) => [...current, node]);

      const parentData = parent.data as Record<string, unknown>;
      const needsExplicitBranch =
        parent.type === "condition" ||
        (parent.type === "action" && parentData.actionType === "abSplit");

      if (!needsExplicitBranch) {
        setEdges((current) =>
          addEdge(
            {
              id: `edge_${parent.id}_${node.id}`,
              source: parent.id,
              target: node.id,
              animated: true,
              style: { stroke: "var(--border)", strokeWidth: 2 },
            },
            current
          )
        );
      } else {
        setSaveError("Step added. Connect it to the branch you want.");
        setTimeout(() => setSaveError(null), 3500);
      }

      setSelectedNodeId(node.id);
      setAddMenuOpen(false);
      setAddAfterNodeId(null);
      markDirty();

      requestAnimationFrame(() => {
        void fitView({ duration: 250, padding: 0.2 });
      });
    },
    [
      addAfterNodeId,
      addNodeAtCanvasCenter,
      createNode,
      fitView,
      markDirty,
      nodes,
      setEdges,
      setNodes,
    ]
  );

  const duplicateNode = useCallback(
    (nodeIdToDuplicate: string) => {
      const source = nodes.find((node) => node.id === nodeIdToDuplicate);
      if (!source) return;

      const duplicated: Node = {
        id: getNodeId(),
        type: source.type,
        position: {
          x: source.position.x + 40,
          y: source.position.y + 80,
        },
        data: JSON.parse(JSON.stringify(source.data)) as Record<string, unknown>,
      };

      setNodes((current) => [...current, duplicated]);
      setSelectedNodeId(duplicated.id);
      markDirty();
    },
    [markDirty, nodes, setNodes]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            animated: true,
            style: { stroke: "var(--border)", strokeWidth: 2 },
          },
          current
        )
      );
      markDirty();
    },
    [markDirty, setEdges]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      applyNodeChanges(changes);
      if (
        changes.some(
          (change) =>
            change.type === "position" ||
            change.type === "remove" ||
            change.type === "add"
        )
      ) {
        markDirty();
      }
    },
    [applyNodeChanges, markDirty]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      applyEdgeChanges(changes);
      if (
        changes.some(
          (change) => change.type === "remove" || change.type === "add"
        )
      ) {
        markDirty();
      }
    },
    [applyEdgeChanges, markDirty]
  );

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();

      const raw = event.dataTransfer.getData("application/reactflow");
      if (!raw) return;

      const item = JSON.parse(raw) as Pick<
        PaletteItem,
        "type" | "nodeType" | "actionType"
      >;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const node = createNode(item, position);
      setNodes((current) => [...current, node]);
      setSelectedNodeId(node.id);
      markDirty();
    },
    [createNode, markDirty, screenToFlowPosition, setNodes]
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      setSelectedNodeId(node.id);
      setVersionPanelOpen(false);
      setTestPanelOpen(false);
    },
    []
  );

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const onNodeDataChange = useCallback(
    (nodeIdToChange: string, newData: Record<string, unknown>) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeIdToChange ? { ...node, data: newData } : node
        )
      );
      markDirty();
    },
    [markDirty, setNodes]
  );

  const closeSidebar = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const deleteNode = useCallback(
    (nodeIdToDelete: string) => {
      setNodes((current) =>
        current.filter((node) => node.id !== nodeIdToDelete)
      );
      setEdges((current) =>
        current.filter(
          (edge) =>
            edge.source !== nodeIdToDelete && edge.target !== nodeIdToDelete
        )
      );
      setSelectedNodeId(null);
      markDirty();
    },
    [markDirty, setEdges, setNodes]
  );

  const saveFlow = useCallback(async () => {
    const versionAtStart = changeVersionRef.current;
    setSaving(true);

    try {
      const update: Database["public"]["Tables"]["flows"]["Update"] = {
        name: flowName.trim() || "Untitled flow",
        nodes: getPersistableNodes(nodes) as unknown as Json,
        edges: edges as unknown as Json,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("flows")
        .update(update)
        .eq("id", flow.id);

      if (error) {
        console.error("Failed to save flow:", error);
        setSaveError("Failed to save");
        return false;
      }

      setSaveError(null);
      setLastSaved(new Date());
      if (changeVersionRef.current === versionAtStart) {
        setDirty(false);
      }
      return true;
    } finally {
      setSaving(false);
    }
  }, [edges, flow.id, flowName, nodes, supabase]);

  const handlePublish = useCallback(async () => {
    const issues = validateFlow(nodes, edges);
    if (issues.length > 0) {
      setPublishIssues(issues);
      const firstNodeIssue = issues.find((issue) => issue.nodeId);
      if (firstNodeIssue?.nodeId) {
        setSelectedNodeId(firstNodeIssue.nodeId);
        setVersionPanelOpen(false);
        setTestPanelOpen(false);
      }
      return;
    }

    setPublishIssues([]);
    setPublishing(true);

    try {
      const saved = await saveFlow();
      if (!saved) return;

      const response = await fetch(`/api/v1/flows/${flow.id}/publish`, {
        method: "POST",
      });

      if (!response.ok) {
        console.error("Failed to publish flow");
        setSaveError("Failed to publish");
        return;
      }

      setSaveError(null);
      setLastSaved(new Date());
      router.refresh();
    } finally {
      setPublishing(false);
    }
  }, [edges, flow.id, nodes, router, saveFlow]);

  useEffect(() => {
    if (!dirty || saving || publishing) return;

    const timeout = window.setTimeout(() => {
      void saveFlow();
    }, 1200);

    return () => window.clearTimeout(timeout);
  }, [dirty, flowName, nodes, edges, publishing, saveFlow, saving]);

  useEffect(() => {
    if (publishIssues.length > 0 && validationIssues.length === 0) {
      setPublishIssues([]);
    }
  }, [publishIssues.length, validationIssues.length]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveFlow();
        return;
      }

      if (
        !isTyping &&
        selectedNodeId &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "d"
      ) {
        event.preventDefault();
        duplicateNode(selectedNodeId);
        return;
      }

      if (!isTyping && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setAddAfterNodeId(selectedNodeId);
        setAddMenuOpen(true);
      }

      if (event.key === "Escape" && addMenuOpen) {
        setAddMenuOpen(false);
        setAddAfterNodeId(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addMenuOpen, duplicateNode, saveFlow, selectedNodeId]);

  const statusText = saveError
    ? saveError
    : saving
      ? "Saving..."
      : dirty
        ? "Unsaved changes"
        : lastSaved
          ? `Saved ${lastSaved.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}`
          : "Autosave on";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => router.push("/dashboard/flows")}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>

          <div className="h-5 w-px bg-border" />

          <input
            type="text"
            value={flowName}
            onChange={(event) => {
              setFlowName(event.target.value);
              markDirty();
            }}
            className="min-w-0 max-w-[240px] border-none bg-transparent text-sm font-semibold outline-none focus:ring-0"
            style={{ width: `${Math.max(Math.min(flowName.length, 28), 8)}ch` }}
            placeholder="Flow name"
          />

          <span
            className={cn(
              "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium",
              flow.status === "published"
                ? "bg-emerald-100 text-emerald-800"
                : flow.status === "archived"
                  ? "bg-amber-100 text-amber-800"
                  : "bg-muted text-muted-foreground"
            )}
          >
            {flow.status}
          </span>

          <span
            className={cn(
              "hidden items-center gap-1 text-xs md:flex",
              saveError
                ? "text-destructive"
                : dirty
                  ? "text-amber-600"
                  : "text-muted-foreground"
            )}
          >
            {!saveError && !dirty && !saving && (
              <Check className="h-3.5 w-3.5" />
            )}
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {statusText}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setAddAfterNodeId(selectedNodeId);
              setAddMenuOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
            title="Shortcut: A"
          >
            <Plus className="h-3.5 w-3.5" />
            Add step
          </button>

          <button
            onClick={() => {
              setTestPanelOpen(!testPanelOpen);
              if (!testPanelOpen) {
                setVersionPanelOpen(false);
                setSelectedNodeId(null);
              }
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
              testPanelOpen
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background hover:bg-accent"
            )}
          >
            <Play className="h-3.5 w-3.5" />
            Test
          </button>

          <button
            onClick={() => {
              setVersionPanelOpen(!versionPanelOpen);
              if (!versionPanelOpen) {
                setTestPanelOpen(false);
                setSelectedNodeId(null);
              }
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
              versionPanelOpen
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background hover:bg-accent"
            )}
          >
            <History className="h-3.5 w-3.5" />
            History
          </button>

          <button
            onClick={() => {
              const exportData = {
                name: flowName,
                description: flow.description || null,
                nodes: getPersistableNodes(nodes),
                edges,
                version: flow.version || 1,
                exportedAt: new Date().toISOString(),
                source: "almostmc",
              };
              const blob = new Blob([JSON.stringify(exportData, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `${flowName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")}.flow.json`;
              anchor.click();
              URL.revokeObjectURL(url);
            }}
            className="hidden items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent xl:inline-flex"
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </button>

          <button
            onClick={() => void saveFlow()}
            disabled={saving}
            className="hidden items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50 lg:inline-flex"
            title="Ctrl/Cmd + S"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>

          <button
            onClick={() => void handlePublish()}
            disabled={publishing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {publishing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Rocket className="h-3.5 w-3.5" />
            )}
            Publish
          </button>
        </div>
      </div>

      {publishIssues.length > 0 && (
        <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-4 py-2 text-amber-900">
          <div className="flex items-center gap-2 text-xs">
            <AlertTriangle className="h-4 w-4" />
            <span className="font-semibold">
              {publishIssues.length} issue{publishIssues.length === 1 ? "" : "s"} before publishing.
            </span>
            <span className="hidden sm:inline">
              {publishIssues[0]?.message}
            </span>
          </div>
          {publishIssues[0]?.nodeId && (
            <button
              type="button"
              onClick={() => setSelectedNodeId(publishIssues[0].nodeId || null)}
              className="rounded-md px-2 py-1 text-xs font-semibold hover:bg-amber-100"
            >
              Review
            </button>
          )}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <NodePalette onAdd={addNodeAtCanvasCenter} />

        <div ref={reactFlowWrapper} className="relative flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            deleteKeyCode={["Backspace", "Delete"]}
            proOptions={{ hideAttribution: true }}
            className="bg-background"
          >
            <Background gap={18} size={1} className="!bg-background" />
            <Controls className="!border-border !bg-card !shadow-sm [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-foreground [&>button:hover]:!bg-accent" />
            <MiniMap
              className="!border-border !bg-card"
              nodeColor={() => "var(--primary)"}
              maskColor="rgba(0, 0, 0, 0.08)"
            />
          </ReactFlow>

          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="pointer-events-auto w-[380px] rounded-2xl border border-border bg-card/95 p-6 text-center shadow-lg">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Plus className="h-5 w-5" />
                </div>
                <h2 className="mt-3 text-base font-semibold text-foreground">
                  Build your first path
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Start with a trigger, then add messages, logic and actions.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setAddAfterNodeId(null);
                    setAddMenuOpen(true);
                  }}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                >
                  <Plus className="h-4 w-4" />
                  Add first step
                </button>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Shortcut: press A anywhere on the canvas.
                </p>
              </div>
            </div>
          )}

          <AddStepMenu
            open={addMenuOpen}
            title={addAfterNodeId ? "Add next step" : "Add a step"}
            onClose={() => {
              setAddMenuOpen(false);
              setAddAfterNodeId(null);
            }}
            onSelect={handleQuickAdd}
          />
        </div>

        {selectedNode && !versionPanelOpen && !testPanelOpen && (
          <NodeConfigSidebar
            node={selectedNode}
            onChange={onNodeDataChange}
            onClose={closeSidebar}
            onDelete={deleteNode}
            onDuplicate={duplicateNode}
            onAddNext={openAddNext}
          />
        )}

        {versionPanelOpen && (
          <VersionHistoryPanel
            flowId={flow.id}
            currentVersion={flow.version}
            onClose={() => setVersionPanelOpen(false)}
            onRestore={() => router.refresh()}
          />
        )}

        {testPanelOpen && (
          <TestPanel
            nodes={nodes}
            edges={edges}
            onClose={() => setTestPanelOpen(false)}
            onHighlightNode={(nodeIdToHighlight) => {
              const node = nodes.find(
                (item) => item.id === nodeIdToHighlight
              );
              if (node) setSelectedNodeId(nodeIdToHighlight);
            }}
          />
        )}
      </div>
    </div>
  );
}

export function FlowCanvas({ flow }: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner flow={flow} />
    </ReactFlowProvider>
  );
}
