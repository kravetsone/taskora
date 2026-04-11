import { useCallback, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ReactFlow, Background, Controls, type Node, type Edge, Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { api } from "@/lib/api";
import { nodeColor, relativeTime } from "@/lib/utils";

function buildGraph(detail: NonNullable<Awaited<ReturnType<typeof api.getWorkflow>>>) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Simple layered layout
  const layers = new Map<number, number[]>();

  // BFS to determine layers
  const depth = new Map<number, number>();
  const queue: number[] = [];

  for (let i = 0; i < detail.graph.nodes.length; i++) {
    if (detail.graph.nodes[i].deps.length === 0) {
      depth.set(i, 0);
      queue.push(i);
    }
  }

  while (queue.length > 0) {
    const idx = queue.shift()!;
    const d = depth.get(idx)!;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(idx);

    for (let j = 0; j < detail.graph.nodes.length; j++) {
      if (detail.graph.nodes[j].deps.includes(idx)) {
        const newDepth = d + 1;
        if (!depth.has(j) || depth.get(j)! < newDepth) {
          depth.set(j, newDepth);
          queue.push(j);
        }
      }
    }
  }

  // Position nodes
  for (const [layer, indices] of layers) {
    indices.forEach((idx, row) => {
      const gNode = detail.graph.nodes[idx];
      const nState = detail.nodes[idx];
      const color = nodeColor(nState.state);

      nodes.push({
        id: String(idx),
        position: { x: layer * 220, y: row * 100 },
        data: {
          label: (
            <div className="text-center">
              <div className="text-xs font-medium" style={{ color }}>
                {gNode.taskName}
              </div>
              <div className="text-[10px] text-board-muted mt-0.5">{nState.state}</div>
            </div>
          ),
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: "var(--board-surface)",
          border: `2px solid ${color}`,
          borderRadius: 8,
          padding: "8px 12px",
          minWidth: 120,
        },
      });
    });
  }

  // Edges
  for (let i = 0; i < detail.graph.nodes.length; i++) {
    for (const dep of detail.graph.nodes[i].deps) {
      const sourceState = detail.nodes[dep].state;
      edges.push({
        id: `${dep}-${i}`,
        source: String(dep),
        target: String(i),
        animated: sourceState === "active",
        style: {
          stroke: sourceState === "completed" ? "#22c55e" : "#71717a",
          strokeWidth: 2,
        },
      });
    }
  }

  return { nodes, edges };
}

export function WorkflowDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const queryClient = useQueryClient();

  const { data: detail } = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => api.getWorkflow(workflowId!),
    refetchInterval: 30_000,
  });

  const cancelWf = useMutation({
    mutationFn: () => api.cancelWorkflow(workflowId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workflow", workflowId] }),
  });

  const graph = useMemo(() => (detail ? buildGraph(detail) : null), [detail]);

  if (!detail || !graph) {
    return <div className="p-6 text-board-muted">Loading...</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <Link to="/workflows" className="text-xs text-board-muted hover:text-board-text">
            &larr; Workflows
          </Link>
          <div className="flex items-center gap-3 mt-1">
            <h2 className="text-lg font-semibold">
              {detail.graph.name ?? <span className="font-mono">{detail.id.slice(0, 12)}...</span>}
            </h2>
            <Badge state={detail.state} />
          </div>
          <div className="text-xs text-board-muted mt-1">
            {detail.graph.name && <span className="font-mono mr-2">{detail.id.slice(0, 12)}...</span>}
            Created {relativeTime(detail.createdAt)} | {detail.graph.nodes.length} nodes
          </div>
        </div>
        {detail.state === "running" && (
          <Button variant="danger" onClick={() => cancelWf.mutate()} disabled={cancelWf.isPending}>
            Cancel
          </Button>
        )}
      </div>

      {/* DAG Visualization */}
      <div
        className="rounded-lg border border-board-border bg-board-surface overflow-hidden"
        style={{ height: 400 }}
      >
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
        >
          <Background color="var(--board-border)" gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* Node list */}
      <div className="rounded-lg border border-board-border bg-board-surface overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-board-border text-board-muted text-xs">
              <th className="text-left px-4 py-2 font-medium">#</th>
              <th className="text-left px-3 py-2 font-medium">Task</th>
              <th className="text-left px-3 py-2 font-medium">State</th>
              <th className="text-left px-3 py-2 font-medium">Job ID</th>
              <th className="text-left px-4 py-2 font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            {detail.nodes.map((node) => (
              <tr
                key={node.index}
                className="border-b border-board-border/50 hover:bg-board-border/20"
              >
                <td className="px-4 py-2.5 text-board-muted">{node.index}</td>
                <td className="px-3 py-2.5 font-medium">
                  {detail.graph.nodes[node.index].taskName}
                </td>
                <td className="px-3 py-2.5">
                  <Badge state={node.state} />
                </td>
                <td className="px-3 py-2.5">
                  <Link
                    to={`/jobs/${node.jobId}`}
                    className="text-board-primary hover:underline font-mono text-xs"
                  >
                    {node.jobId.slice(0, 8)}...
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-xs text-red-400 max-w-[200px] truncate">
                  {node.error ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
