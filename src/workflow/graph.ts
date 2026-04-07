import { randomUUID } from "node:crypto";
import type { Taskora } from "../types.js";
import type {
  AnySignature,
  ChainSignature,
  ChordSignature,
  GroupSignature,
  Signature,
} from "./signature.js";

// ── WorkflowGraph — serializable DAG ────────────────────────────────

export interface WorkflowNode {
  taskName: string;
  /** Serialized bound data. Absent = receives from predecessor(s). */
  data?: string;
  /** Predecessor node indices. */
  deps: number[];
  /** Pre-generated job ID. */
  jobId: string;
  /** Task version captured at signature creation. */
  _v: number;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  /** Indices of terminal nodes (define final result). */
  terminal: number[];
}

// ── Flatten composition tree → DAG ──────────────────────────────────

export function flattenToDAG(root: AnySignature, serializer: Taskora.Serializer): WorkflowGraph {
  const nodes: WorkflowNode[] = [];

  /**
   * Recursively flatten a composition node.
   * @param comp - The composition node
   * @param inputDeps - Node indices this node depends on (from parent context)
   * @returns Array of output node indices (used as deps for next steps)
   */
  function flatten(comp: AnySignature, inputDeps: number[]): number[] {
    switch (comp._tag) {
      case "signature": {
        const sig = comp as Signature<unknown, unknown>;
        const idx = nodes.length;
        const node: WorkflowNode = {
          taskName: sig.task.name,
          deps: inputDeps,
          jobId: randomUUID(),
          _v: sig._v,
        };
        if (sig.hasBoundData) {
          node.data = serializer.serialize(sig.boundData);
        }
        nodes.push(node);
        return [idx];
      }

      case "chain": {
        const chain = comp as ChainSignature<unknown, unknown>;
        let currentDeps = inputDeps;
        for (const step of chain.steps) {
          currentDeps = flatten(step, currentDeps);
        }
        return currentDeps;
      }

      case "group": {
        const group = comp as GroupSignature<unknown>;
        const allOutputs: number[] = [];
        for (const member of group.members) {
          const outputs = flatten(member, inputDeps);
          allOutputs.push(...outputs);
        }
        return allOutputs;
      }

      case "chord": {
        const chord = comp as ChordSignature<unknown>;
        const headerOutputs: number[] = [];
        for (const member of chord.header) {
          const outputs = flatten(member, inputDeps);
          headerOutputs.push(...outputs);
        }
        return flatten(chord.callback, headerOutputs);
      }
    }
  }

  const terminal = flatten(root, []);

  // Validate: root nodes without deps must have bound data
  for (const node of nodes) {
    if (node.deps.length === 0 && node.data === undefined) {
      throw new Error(
        `Task "${node.taskName}" is a root node in the workflow but has no bound data. Use task.s(data) to bind input data for the first step.`,
      );
    }
  }

  return { nodes, terminal };
}
