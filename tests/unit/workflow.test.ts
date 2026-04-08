import { describe, expect, it, beforeEach } from "vitest";
import { createTestRunner } from "../../src/test/index.js";
import {
  chain,
  group,
  chord,
  Signature,
  ChainSignature,
  GroupSignature,
  ChordSignature,
} from "../../src/workflow/index.js";
import { flattenToDAG } from "../../src/workflow/graph.js";
import { json } from "../../src/serializer.js";
import type { Task } from "../../src/task.js";

describe("Workflow", () => {
  let runner: ReturnType<typeof createTestRunner>;
  let add: Task<{ x: number; y: number }, number>;
  let double: Task<number, number>;
  let sum: Task<number[], number>;
  let echo: Task<string, string>;
  let identity: Task<unknown, unknown>;

  beforeEach(() => {
    runner = createTestRunner();
    add = runner.app.task("add", async (data: { x: number; y: number }) => data.x + data.y);
    double = runner.app.task("double", async (data: number) => data * 2);
    sum = runner.app.task("sum", async (data: number[]) => data.reduce((a, b) => a + b, 0));
    echo = runner.app.task("echo", async (data: string) => data);
    identity = runner.app.task("identity", async (data: unknown) => data);
  });

  // ── Signature ────────────────────────────────────────────────────

  describe("Signature", () => {
    it("task.s(data) creates a signature with bound data", () => {
      const sig = add.s({ x: 1, y: 2 });
      expect(sig).toBeInstanceOf(Signature);
      expect(sig._tag).toBe("signature");
      expect(sig.boundData).toEqual({ x: 1, y: 2 });
      expect(sig.hasBoundData).toBe(true);
      expect(sig.task).toBe(add);
    });

    it("task.s() creates a signature without data", () => {
      const sig = double.s();
      expect(sig.boundData).toBeUndefined();
      expect(sig.hasBoundData).toBe(false);
    });

    it(".pipe() creates a chain", () => {
      const piped = add.s({ x: 1, y: 2 }).pipe(double.s());
      expect(piped).toBeInstanceOf(ChainSignature);
      expect(piped._tag).toBe("chain");
      expect(piped.steps).toHaveLength(2);
    });

    it("chained .pipe() appends steps", () => {
      const piped = add.s({ x: 1, y: 2 }).pipe(double.s()).pipe(double.s());
      expect(piped.steps).toHaveLength(3);
    });
  });

  // ── chain() ──────────────────────────────────────────────────────

  describe("chain()", () => {
    it("creates a ChainSignature", () => {
      const c = chain(add.s({ x: 1, y: 2 }), double.s());
      expect(c).toBeInstanceOf(ChainSignature);
      expect(c.steps).toHaveLength(2);
    });

    it("throws with no steps", () => {
      expect(() => (chain as any)()).toThrow("at least one step");
    });
  });

  // ── group() ──────────────────────────────────────────────────────

  describe("group()", () => {
    it("creates a GroupSignature", () => {
      const g = group(add.s({ x: 1, y: 2 }), add.s({ x: 3, y: 4 }));
      expect(g).toBeInstanceOf(GroupSignature);
      expect(g.members).toHaveLength(2);
    });

    it("throws with no members", () => {
      expect(() => (group as any)()).toThrow("at least one");
    });
  });

  // ── chord() ─────────────────────────────────────────────────────

  describe("chord()", () => {
    it("creates a ChordSignature", () => {
      const c = chord([add.s({ x: 1, y: 2 }), add.s({ x: 3, y: 4 })], sum.s());
      expect(c).toBeInstanceOf(ChordSignature);
      expect(c.header).toHaveLength(2);
      expect(c.callback._tag).toBe("signature");
    });

    it("throws with empty header", () => {
      expect(() => (chord as any)([], sum.s())).toThrow("at least one");
    });
  });

  // ── DAG flattening ───────────────────────────────────────────────

  describe("flattenToDAG", () => {
    const serializer = json();

    it("single signature", () => {
      const graph = flattenToDAG(add.s({ x: 1, y: 2 }), serializer);
      expect(graph.nodes).toHaveLength(1);
      expect(graph.terminal).toEqual([0]);
      expect(graph.nodes[0].taskName).toBe("add");
      expect(graph.nodes[0].deps).toEqual([]);
      expect(graph.nodes[0].data).toBe(JSON.stringify({ x: 1, y: 2 }));
    });

    it("chain(a, b, c)", () => {
      const graph = flattenToDAG(chain(add.s({ x: 1, y: 2 }), double.s(), double.s()), serializer);
      expect(graph.nodes).toHaveLength(3);
      expect(graph.nodes[0].deps).toEqual([]);
      expect(graph.nodes[1].deps).toEqual([0]);
      expect(graph.nodes[2].deps).toEqual([1]);
      expect(graph.terminal).toEqual([2]);
    });

    it("group(a, b)", () => {
      const graph = flattenToDAG(group(add.s({ x: 1, y: 2 }), add.s({ x: 3, y: 4 })), serializer);
      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes[0].deps).toEqual([]);
      expect(graph.nodes[1].deps).toEqual([]);
      expect(graph.terminal).toEqual([0, 1]);
    });

    it("chord([a, b], c)", () => {
      const graph = flattenToDAG(
        chord([add.s({ x: 1, y: 2 }), add.s({ x: 3, y: 4 })], sum.s()),
        serializer,
      );
      expect(graph.nodes).toHaveLength(3);
      expect(graph.nodes[0].deps).toEqual([]);
      expect(graph.nodes[1].deps).toEqual([]);
      expect(graph.nodes[2].deps).toEqual([0, 1]);
      expect(graph.terminal).toEqual([2]);
    });

    it("chain(a, group(b, c), d)", () => {
      const graph = flattenToDAG(
        chain(add.s({ x: 1, y: 2 }), group(double.s(), double.s()), sum.s()),
        serializer,
      );
      expect(graph.nodes).toHaveLength(4);
      // a
      expect(graph.nodes[0].deps).toEqual([]);
      // b and c depend on a
      expect(graph.nodes[1].deps).toEqual([0]);
      expect(graph.nodes[2].deps).toEqual([0]);
      // d depends on b and c
      expect(graph.nodes[3].deps).toEqual([1, 2]);
      expect(graph.terminal).toEqual([3]);
    });

    it("chord([chain(a,b), chain(c,d)], e)", () => {
      const graph = flattenToDAG(
        chord(
          [chain(add.s({ x: 1, y: 2 }), double.s()), chain(add.s({ x: 3, y: 4 }), double.s())],
          sum.s(),
        ),
        serializer,
      );
      expect(graph.nodes).toHaveLength(5);
      expect(graph.nodes[0].deps).toEqual([]); // a
      expect(graph.nodes[1].deps).toEqual([0]); // b
      expect(graph.nodes[2].deps).toEqual([]); // c
      expect(graph.nodes[3].deps).toEqual([2]); // d
      expect(graph.nodes[4].deps).toEqual([1, 3]); // e
      expect(graph.terminal).toEqual([4]);
    });

    it("validates root nodes have bound data", () => {
      expect(() => flattenToDAG(double.s(), serializer)).toThrow("no bound data");
    });

    it("pre-generates unique job IDs", () => {
      const graph = flattenToDAG(chain(add.s({ x: 1, y: 2 }), double.s()), serializer);
      expect(graph.nodes[0].jobId).toBeTruthy();
      expect(graph.nodes[1].jobId).toBeTruthy();
      expect(graph.nodes[0].jobId).not.toBe(graph.nodes[1].jobId);
    });
  });

  // ── Execution: chain ─────────────────────────────────────────────

  describe("chain execution", () => {
    it("executes a two-step chain", async () => {
      const handle = add.s({ x: 3, y: 4 }).pipe(double.s()).dispatch();
      await handle; // ensure dispatched

      // Process all jobs
      for (let i = 0; i < 10; i++) {
        await runner.processAll();
        const state = await handle.getState();
        if (state === "completed") break;
        // Need to check if there are delayed jobs
        await new Promise((r) => setTimeout(r, 5));
      }

      const result = await handle.result;
      expect(result).toBe(14); // (3+4) * 2
    });

    it("executes a three-step chain", async () => {
      const handle = chain(add.s({ x: 5, y: 5 }), double.s(), double.s()).dispatch();
      await handle;

      for (let i = 0; i < 10; i++) {
        await runner.processAll();
        const state = await handle.getState();
        if (state === "completed") break;
        await new Promise((r) => setTimeout(r, 5));
      }

      const result = await handle.result;
      expect(result).toBe(40); // (5+5) * 2 * 2
    });
  });

  // ── Execution: group ─────────────────────────────────────────────

  describe("group execution", () => {
    it("executes parallel group", async () => {
      const handle = group(
        add.s({ x: 1, y: 2 }),
        add.s({ x: 3, y: 4 }),
        add.s({ x: 5, y: 6 }),
      ).dispatch();
      await handle;

      for (let i = 0; i < 10; i++) {
        await runner.processAll();
        const state = await handle.getState();
        if (state === "completed") break;
        await new Promise((r) => setTimeout(r, 5));
      }

      const result = await handle.result;
      expect(result).toEqual([3, 7, 11]);
    });
  });

  // ── Execution: chord ─────────────────────────────────────────────

  describe("chord execution", () => {
    it("executes chord (group + callback)", async () => {
      const handle = chord([add.s({ x: 1, y: 2 }), add.s({ x: 3, y: 4 })], sum.s()).dispatch();
      await handle;

      for (let i = 0; i < 10; i++) {
        await runner.processAll();
        const state = await handle.getState();
        if (state === "completed") break;
        await new Promise((r) => setTimeout(r, 5));
      }

      const result = await handle.result;
      expect(result).toBe(10); // sum([3, 7])
    });
  });

  // ── Execution: nested ────────────────────────────────────────────

  describe("nested composition", () => {
    it("chord([chain, chain], callback)", async () => {
      const handle = chord(
        [chain(add.s({ x: 1, y: 1 }), double.s()), chain(add.s({ x: 2, y: 2 }), double.s())],
        sum.s(),
      ).dispatch();
      await handle;

      for (let i = 0; i < 20; i++) {
        await runner.processAll();
        const state = await handle.getState();
        if (state === "completed") break;
        await new Promise((r) => setTimeout(r, 5));
      }

      const result = await handle.result;
      expect(result).toBe(12); // sum([2*2, 4*2]) = sum([4, 8])
    });
  });

  // ── Workflow state ───────────────────────────────────────────────

  describe("workflow state", () => {
    it("tracks state transitions", async () => {
      const handle = add.s({ x: 1, y: 2 }).dispatch();
      await handle;

      const stateBefore = await handle.getState();
      expect(stateBefore).toBe("running");

      await runner.processAll();
      // After processing, let workflow advance happen
      await new Promise((r) => setTimeout(r, 10));

      const stateAfter = await handle.getState();
      expect(stateAfter).toBe("completed");
    });
  });

  // ── runner.steps ─────────────────────────────────────────────────

  describe("runner.steps", () => {
    it("tracks workflow step completions", async () => {
      const handle = chain(add.s({ x: 1, y: 2 }), double.s()).dispatch();
      await handle;

      for (let i = 0; i < 10; i++) {
        await runner.processAll();
        const state = await handle.getState();
        if (state === "completed") break;
        await new Promise((r) => setTimeout(r, 5));
      }

      expect(runner.steps.length).toBeGreaterThanOrEqual(2);
      expect(runner.steps[0].taskName).toBe("add");
      expect(runner.steps[0].state).toBe("completed");
      expect(runner.steps[1].taskName).toBe("double");
      expect(runner.steps[1].state).toBe("completed");
    });

    it("clears steps on clear()", async () => {
      const handle = add.s({ x: 1, y: 2 }).dispatch();
      await handle;
      await runner.processAll();
      await new Promise((r) => setTimeout(r, 10));

      expect(runner.steps.length).toBeGreaterThan(0);
      runner.clear();
      expect(runner.steps).toHaveLength(0);
    });
  });

  // ── .map() and .chunk() ──────────────────────────────────────────

  describe("task.map()", () => {
    it("dispatches items in parallel", async () => {
      const handle = add.map([
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ]);
      await handle;

      for (let i = 0; i < 10; i++) {
        await runner.processAll();
        const state = await handle.getState();
        if (state === "completed") break;
        await new Promise((r) => setTimeout(r, 5));
      }

      const result = await handle.result;
      expect(result).toEqual([2, 4, 6]);
    });
  });

  // ── Workflow failure ─────────────────────────────────────────────

  describe("workflow failure", () => {
    it("fails workflow on permanent task failure", async () => {
      const fail = runner.app.task("fail", async () => {
        throw new Error("boom");
      });

      const handle = chain(add.s({ x: 1, y: 2 }), fail.s()).dispatch();
      await handle;

      for (let i = 0; i < 10; i++) {
        await runner.processAll();
        const state = await handle.getState();
        if (state && state !== "running") break;
        await new Promise((r) => setTimeout(r, 5));
      }

      const state = await handle.getState();
      expect(state).toBe("failed");
    });
  });
});
