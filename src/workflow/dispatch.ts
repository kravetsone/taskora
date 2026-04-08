import { randomUUID } from "node:crypto";
import { parseDuration } from "../scheduler/duration.js";
import type { Task, TaskDeps } from "../task.js";
import type { Taskora } from "../types.js";
import { type WorkflowGraph, flattenToDAG } from "./graph.js";
import { WorkflowHandle } from "./handle.js";
import {
  type AnySignature,
  type ChainSignature,
  type ChordSignature,
  type GroupSignature,
  type Signature,
  type WorkflowDispatchOptions,
  _setDispatch,
} from "./signature.js";

/**
 * Dispatch any composition as a workflow.
 * Creates the workflow in the adapter, enqueues root nodes, returns a handle.
 */
function dispatchWorkflow<T>(
  comp: AnySignature,
  options?: WorkflowDispatchOptions,
): WorkflowHandle<T> {
  const deps = extractDeps(comp);
  const { adapter, serializer, ensureConnected } = deps;
  const workflowId = randomUUID();
  const graph = flattenToDAG(comp, serializer);

  // Attach name: explicit or auto-generated from composition structure
  graph.name = options?.name ?? describeComposition(comp);

  const dispatchPromise = (async () => {
    await ensureConnected();
    await adapter.createWorkflow(workflowId, JSON.stringify(graph));

    // Enqueue all root nodes (no dependencies)
    for (let i = 0; i < graph.nodes.length; i++) {
      const node = graph.nodes[i];
      if (node.deps.length === 0) {
        await adapter.enqueue(node.taskName, node.jobId, node.data as string, {
          _v: node._v,
          _wf: workflowId,
          _wfNode: i,
        });
      }
    }

    // Schedule workflow TTL as delayed cancel
    if (options?.ttl) {
      const ttlMs = parseDuration(options.ttl);
      scheduleWorkflowTimeout(adapter, workflowId, graph, ttlMs);
    }
  })();

  return new WorkflowHandle<T>(workflowId, graph, adapter, serializer, dispatchPromise);
}

/**
 * Schedule a workflow timeout — cancel the workflow after ttlMs.
 * Fire-and-forget: timeout is best-effort.
 */
function scheduleWorkflowTimeout(
  adapter: Taskora.Adapter,
  workflowId: string,
  graph: WorkflowGraph,
  ttlMs: number,
): void {
  setTimeout(async () => {
    try {
      const state = await adapter.getWorkflowState(workflowId);
      if (state && JSON.parse(state).state === "running") {
        const { activeJobIds } = await adapter.cancelWorkflow(workflowId, "workflow timeout");
        for (const { task, jobId } of activeJobIds) {
          try {
            await adapter.cancel(task, jobId, "workflow timeout");
          } catch {
            // Job may have finished
          }
        }
      }
    } catch {
      // Best-effort timeout
    }
  }, ttlMs);
}

// ── Extract deps from composition tree ──────────────────────────────

function extractDeps(comp: AnySignature): TaskDeps {
  const leaf = findFirstLeaf(comp);
  if (!leaf) {
    throw new Error("Workflow has no task signatures");
  }
  return leaf.task._getDeps();
}

function findFirstLeaf(comp: AnySignature): Signature<any, any> | null {
  switch (comp._tag) {
    case "signature":
      return comp as Signature<any, any>;
    case "chain":
      return findFirstLeaf((comp as ChainSignature<any, any>).steps[0]);
    case "group":
      return findFirstLeaf((comp as GroupSignature<any>).members[0]);
    case "chord":
      return findFirstLeaf((comp as ChordSignature<any>).header[0]);
  }
}

/**
 * Auto-generate a human-readable description from composition structure.
 * e.g. "chain(resize → watermark → upload-cdn → notify)"
 *      "group(resize, resize, resize)"
 *      "chord(resize, resize, resize → aggregate)"
 */
function describeComposition(comp: AnySignature): string {
  switch (comp._tag) {
    case "signature":
      return (comp as Signature<any, any>).task.name;
    case "chain": {
      const steps = (comp as ChainSignature<any, any>).steps.map(describeComposition);
      return `chain(${steps.join(" → ")})`;
    }
    case "group": {
      const members = (comp as GroupSignature<any>).members.map(describeComposition);
      return `group(${members.join(", ")})`;
    }
    case "chord": {
      const c = comp as ChordSignature<any>;
      const header = c.header.map(describeComposition);
      const callback = describeComposition(c.callback as AnySignature);
      return `chord(${header.join(", ")} → ${callback})`;
    }
  }
}

// Register dispatch function on the signature module
_setDispatch(dispatchWorkflow);
