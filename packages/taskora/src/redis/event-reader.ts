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
        // Track the max entryId per stream in THIS batch only. We commit
        // it to `this.lastIds` after the enrichment pipeline succeeds, so
        // a mid-batch connection failure (throw from `pipe.exec()`) leaves
        // the cursor at its pre-batch position and the next XREAD replays
        // the same entries. Without this, a failing exec silently dropped
        // the whole batch of events.
        const batchLastIds = new Map<string, string>();

        for (const [streamKey, entries] of result) {
          const task = taskByStream.get(streamKey);
          if (!task) continue;
          const keys = buildKeys(task, this.prefix);

          for (const [entryId, fieldArr] of entries) {
            batchLastIds.set(streamKey, entryId);

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

        if (pending.length === 0) {
          // Nothing to enrich/deliver, but we still consumed entries from
          // the XREAD response — malformed entries or non-enriched events
          // we skipped past. Commit the cursor so we don't replay them.
          for (const [k, v] of batchLastIds) this.lastIds.set(k, v);
          continue;
        }

        // Only exec the pipeline if at least one event needs enrichment. This
        // keeps the fast path for "progress" / "stalled" / other enrichment-less
        // events free of a wasted round trip.
        //
        // If `exec()` throws — connection drop, MaxRetriesPerRequestError,
        // NOSCRIPT on a bad day — the surrounding catch swallows it, we
        // sleep, and the next poll tick retries with the OLD cursor because
        // we haven't committed `batchLastIds` yet. That's the invariant
        // guarded by tests/unit/event-reader.test.ts.
        const results: PipelineResult = cmdIdx > 0 ? await pipe.exec() : [];

        // Enrichment succeeded — advance the stream cursor before firing
        // handlers, so a handler that throws doesn't cause a replay either.
        for (const [k, v] of batchLastIds) this.lastIds.set(k, v);

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
        pipe.add("hmget", [jobKey, "attempt", "processedOn", "finishedOn", "result"]);
        return { kind: "completed", count: 1 };
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
        if (meta[3]) p.fields.result = meta[3];
      }
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
