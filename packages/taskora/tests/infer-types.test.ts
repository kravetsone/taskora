import { describe, expectTypeOf, it } from "vitest";
import * as z from "zod";
import {
  type InferInput,
  type InferOutput,
  type ResultHandle,
  type Taskora,
  chain,
  chord,
  createTaskora,
  defineTask,
  group,
  staticContract,
} from "../src/index.js";

describe("InferInput / InferOutput", () => {
  const app = createTaskora({ adapter: {} as any });

  it("infers input and output from defineTask contract", () => {
    const sendEmailTask = defineTask({
      name: "send-email",
      input: z.object({ to: z.string(), subject: z.string() }),
      output: z.object({ messageId: z.string() }),
    });

    expectTypeOf<InferInput<typeof sendEmailTask>>().toEqualTypeOf<{
      to: string;
      subject: string;
    }>();
    expectTypeOf<InferOutput<typeof sendEmailTask>>().toEqualTypeOf<{ messageId: string }>();
  });

  it("infers from staticContract", () => {
    const ping = staticContract<{ host: string }, { latencyMs: number }>({ name: "ping" });

    expectTypeOf<InferInput<typeof ping>>().toEqualTypeOf<{ host: string }>();
    expectTypeOf<InferOutput<typeof ping>>().toEqualTypeOf<{ latencyMs: number }>();
  });

  it("infers from Task created via app.task()", () => {
    const processImageTask = app.task("process-image", {
      input: z.object({ url: z.string() }),
      output: z.object({ width: z.number(), height: z.number() }),
      handler: async () => ({ width: 0, height: 0 }),
    });

    expectTypeOf<InferInput<typeof processImageTask>>().toEqualTypeOf<{ url: string }>();
    expectTypeOf<InferOutput<typeof processImageTask>>().toEqualTypeOf<{
      width: number;
      height: number;
    }>();
  });

  it("infers from BoundTask (register/implement)", () => {
    const contract = defineTask({
      name: "bound-task",
      input: z.object({ n: z.number() }),
      output: z.object({ doubled: z.number() }),
    });
    const bound = app.register(contract);

    expectTypeOf<InferInput<typeof bound>>().toEqualTypeOf<{ n: number }>();
    expectTypeOf<InferOutput<typeof bound>>().toEqualTypeOf<{ doubled: number }>();
  });

  it("infers output from ResultHandle", () => {
    type Handle = ResultHandle<{ id: string; score: number }>;

    expectTypeOf<InferOutput<Handle>>().toEqualTypeOf<{ id: string; score: number }>();
    // ResultHandle carries no input — resolves to never.
    expectTypeOf<InferInput<Handle>>().toEqualTypeOf<never>();
  });

  it("infers from workflow compositions", () => {
    const taskA = app.task("wf-a", {
      input: z.object({ a: z.number() }),
      output: z.object({ b: z.string() }),
      handler: async () => ({ b: "" }),
    });
    const taskB = app.task("wf-b", {
      input: z.object({ b: z.string() }),
      output: z.object({ c: z.boolean() }),
      handler: async () => ({ c: true }),
    });

    const sigA = taskA.s();
    expectTypeOf<InferInput<typeof sigA>>().toEqualTypeOf<{ a: number }>();
    expectTypeOf<InferOutput<typeof sigA>>().toEqualTypeOf<{ b: string }>();

    const chained = chain(taskA.s(), taskB.s());
    expectTypeOf<InferInput<typeof chained>>().toEqualTypeOf<{ a: number }>();
    expectTypeOf<InferOutput<typeof chained>>().toEqualTypeOf<{ c: boolean }>();

    const grp = group(taskA.s({ a: 1 }), taskB.s({ b: "x" }));
    // Groups carry no single input — resolves to never.
    expectTypeOf<InferInput<typeof grp>>().toEqualTypeOf<never>();
    expectTypeOf<InferOutput<typeof grp>>().toEqualTypeOf<[{ b: string }, { c: boolean }]>();

    const mergeTask = app.task("wf-merge", {
      input: z.tuple([z.object({ b: z.string() }), z.object({ c: z.boolean() })]),
      output: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: true }),
    });
    const chordComp = chord([taskA.s({ a: 1 }), taskB.s({ b: "x" })], mergeTask.s());
    expectTypeOf<InferOutput<typeof chordComp>>().toEqualTypeOf<{ ok: boolean }>();
  });

  it("exposes the same helpers under the Taskora namespace", () => {
    const contract = defineTask({
      name: "namespaced",
      input: z.object({ q: z.string() }),
      output: z.object({ hits: z.number() }),
    });

    expectTypeOf<Taskora.InferInput<typeof contract>>().toEqualTypeOf<{ q: string }>();
    expectTypeOf<Taskora.InferOutput<typeof contract>>().toEqualTypeOf<{ hits: number }>();
  });
});
