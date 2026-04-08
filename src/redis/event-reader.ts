import type { Taskora } from "../types.js";
import type { PipelineBuilder, PipelineResult, RedisDriver } from "./driver.js";
import { buildKeys } from "./keys.js";

// Per-event plan for second-pass enrichment. `start` is the index of this
// event's first command inside the shared pipeline; `count` tells the parser
// how many slots it owns. A `count` of 0 means "no enrichment needed — emit as-is".
type EnrichKind = "completed" | "failed" | "retrying" | "active" | "none";

interface PendingEvent {
  task: string;
  event: string;
  jobId: string;
  fields: Record<string, string>;
  kind: EnrichKind;
  start: number;
}

export class EventReader {
  private readonly driver: RedisDriver;
  private readonly prefix?: string;
  private running = false;
  private lastIds = new Map<string, string>();

  constructor(driver: RedisDriver, prefix?: string) {
    this.driver = driver;
    this.prefix = prefix;
  }

  async start(tasks: string[], handler: (event: Taskora.StreamEvent) => void): Promise<void> {
    this.running = true;

    // Snapshot current stream positions so we don't miss events
    // that arrive between subscribe() and the first XREAD
    for (const task of tasks) {
      const keys = buildKeys(task, this.prefix);
      if (!this.lastIds.has(keys.events)) {
        const last = (await this.driver.command("xrevrange", [
          keys.events,
          "+",
          "-",
          "COUNT",
          "1",
        ])) as Array<[string, string[]]> | null;
        this.lastIds.set(keys.events, last && last.length > 0 ? last[0][0] : "0-0");
      }
    }

    this.poll(tasks, handler);
  }

  async stop(): Promise<void> {
    this.running = false;
    // The driver itself is closed by the caller (`subscribe()` in backend.ts).
  }

  private async poll(
    tasks: string[],
    handler: (event: Taskora.StreamEvent) => void,
  ): Promise<void> {
    const streams: string[] = [];
    const taskByStream = new Map<string, string>();

    for (const task of tasks) {
      const keys = buildKeys(task, this.prefix);
      streams.push(keys.events);
      taskByStream.set(keys.events, task);
    }

    while (this.running) {
      try {
        const ids = streams.map((s) => this.lastIds.get(s) || "$");

        const result = await this.driver.blockingXRead(streams, ids, 5000, 100);

        if (!result) continue;

        // Two-pass batching: parse every entry in the XREAD response, queue all
        // enrichment commands into a SINGLE pipeline, then distribute results
        // and invoke the handler in stream order. A prior implementation awaited
        // one enrich() per event (1–2 RTTs each) — with COUNT=100 that's up to
        // 200 sequential round trips per poll tick. One shared pipeline collapses
        // that to a single RTT per tick.
        const pending: PendingEvent[] = [];
        const pipe = this.driver.pipeline();
        let cmdIdx = 0;

        for (const [streamKey, entries] of result) {
          const task = taskByStream.get(streamKey);
          if (!task) continue;
          const keys = buildKeys(task, this.prefix);

          for (const [entryId, fieldArr] of entries) {
            // Advance lastId unconditionally — even if the entry is malformed
            // or enrichment later fails, we don't want to replay it forever.
            this.lastIds.set(streamKey, entryId);

            const fields: Record<string, string> = {};
            for (let i = 0; i < fieldArr.length; i += 2) {
              fields[fieldArr[i]] = fieldArr[i + 1];
            }

            const event = fields.event;
            const jobId = fields.jobId;
            if (!event || !jobId) continue;

            const jobKey = `${keys.jobPrefix}${jobId}`;
            const added = this.queueEnrichment(pipe, jobKey, event);
            pending.push({ task, event, jobId, fields, kind: added.kind, start: cmdIdx });
            cmdIdx += added.count;
          }
        }

        if (pending.length === 0) continue;

        // Only exec the pipeline if at least one event needs enrichment. This
        // keeps the fast path for "progress" / "stalled" / other enrichment-less
        // events free of a wasted round trip.
        const results: PipelineResult = cmdIdx > 0 ? await pipe.exec() : [];

        for (const p of pending) {
          try {
            applyEnrichment(p, results);
            handler({ task: p.task, event: p.event, jobId: p.jobId, fields: p.fields });
          } catch {
            // Individual event processing error — skip this event, continue with next
          }
        }
      } catch {
        if (!this.running) break;
        await sleep(1000);
      }
    }
  }

  private queueEnrichment(
    pipe: PipelineBuilder,
    jobKey: string,
    event: string,
  ): { kind: EnrichKind; count: number } {
    switch (event) {
      case "completed":
        pipe.add("hmget", [jobKey, "attempt", "processedOn", "finishedOn"]);
        pipe.add("get", [`${jobKey}:result`]);
        return { kind: "completed", count: 2 };
      case "failed":
        pipe.add("hmget", [jobKey, "attempt", "error"]);
        return { kind: "failed", count: 1 };
      case "retrying":
        pipe.add("hget", [jobKey, "error"]);
        return { kind: "retrying", count: 1 };
      case "active":
        pipe.add("hget", [jobKey, "attempt"]);
        return { kind: "active", count: 1 };
      default:
        return { kind: "none", count: 0 };
    }
  }
}

function applyEnrichment(p: PendingEvent, results: PipelineResult): void {
  if (p.kind === "none") return;

  switch (p.kind) {
    case "completed": {
      const meta = results[p.start]?.[1] as (string | null)[] | null;
      if (meta) {
        if (meta[0]) p.fields.attempt = meta[0];
        if (meta[1] && meta[2]) {
          p.fields.duration = String(Number(meta[2]) - Number(meta[1]));
        }
      }
      const resultVal = results[p.start + 1]?.[1] as string | null;
      if (resultVal) p.fields.result = resultVal;
      return;
    }
    case "failed": {
      const meta = results[p.start]?.[1] as (string | null)[] | null;
      if (meta) {
        if (meta[0]) p.fields.attempt = meta[0];
        if (meta[1]) p.fields.error = meta[1];
      }
      return;
    }
    case "retrying": {
      const error = results[p.start]?.[1] as string | null;
      if (error) p.fields.error = error;
      return;
    }
    case "active": {
      const attempt = results[p.start]?.[1] as string | null;
      if (attempt) p.fields.attempt = attempt;
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
