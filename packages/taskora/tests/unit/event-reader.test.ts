// Unit test for EventReader's lastIds advancement.
//
// The invariant under test: if the enrichment pipeline fails (connection
// drop mid-exec, MaxRetriesPerRequestError, server restart, etc.), events
// from the failed batch MUST be replayable on the next poll tick. A
// previous version of `event-reader.ts` advanced `lastIds` per-entry as
// soon as it parsed the XREAD response — BEFORE `pipe.exec()` ran. That
// meant a failing exec silently dropped the batch: next XREAD would
// start past the unacked events and they'd never reach the handler.
//
// Unit-scoped rather than integration because reproducing a mid-exec
// connection failure against real Redis is racy and unreliable. A fake
// RedisDriver lets us control the failure point precisely.

import { describe, expect, it } from "vitest";
import type {
  PipelineBuilder,
  PipelineResult,
  RedisArg,
  RedisDriver,
  Unsubscribe,
  XReadResult,
} from "../../src/redis/driver.js";
import { EventReader } from "../../src/redis/event-reader.js";
import type { Taskora } from "../../src/types.js";

// Minimal fake driver — EventReader only touches `command` (for the
// initial XREVRANGE snapshot), `blockingXRead` (poll), and `pipeline`
// (enrichment). Everything else throws loudly so a silent test drift
// to an untested code path surfaces as a thrown error, not a false pass.
class FakeDriver implements RedisDriver {
  // Queue of XREAD responses; consumed in order. Each element is what
  // the next `blockingXRead` call will return. A `null` element means
  // "BLOCK timeout, no entries" (legal XREAD reply).
  readonly xreadQueue: Array<XReadResult | null> = [];
  // Queue of pipeline behaviors; consumed in order. "throw" makes the
  // next exec() reject with a simulated connection failure; otherwise
  // the element is the PipelineResult to return.
  readonly pipelineBehaviors: Array<PipelineResult | "throw"> = [];
  // Captured: every `ids` array passed into blockingXRead. Used to
  // assert lastIds was not prematurely advanced after a failed exec.
  readonly idsSeen: string[][] = [];

  async command(name: string, _args: RedisArg[]): Promise<unknown> {
    // EventReader uses exactly one `command` call at startup: an
    // XREVRANGE to snapshot the stream's latest ID so we don't replay
    // pre-existing entries. Return an empty response → lastId becomes
    // "0-0" → first XREAD will see all queued entries.
    if (name === "xrevrange") return [];
    throw new Error(`FakeDriver.command: unexpected command "${name}"`);
  }

  async blockingXRead(
    _streams: string[],
    ids: string[],
    _blockMs: number,
    _count: number,
  ): Promise<XReadResult | null> {
    this.idsSeen.push([...ids]);
    if (this.xreadQueue.length === 0) {
      // Starve further polls so the reader stops issuing new XREADs
      // once our scripted sequence is done. `null` = BLOCK timeout.
      await new Promise((r) => setTimeout(r, 50));
      return null;
    }
    const next = this.xreadQueue.shift();
    return next ?? null;
  }

  pipeline(): PipelineBuilder {
    const behavior = this.pipelineBehaviors.shift();
    return new FakePipeline(behavior);
  }

  // ── methods EventReader never touches ──────────────────────────────
  async scriptLoad(): Promise<string> {
    throw new Error("FakeDriver.scriptLoad: not used by EventReader");
  }
  async evalSha(): Promise<unknown> {
    throw new Error("FakeDriver.evalSha: not used by EventReader");
  }
  async blockingZPopMin(): Promise<null> {
    throw new Error("FakeDriver.blockingZPopMin: not used by EventReader");
  }
  async subscribe(): Promise<Unsubscribe> {
    throw new Error("FakeDriver.subscribe: not used by EventReader");
  }
  async duplicate(): Promise<RedisDriver> {
    throw new Error("FakeDriver.duplicate: not used by EventReader");
  }
  async connect(): Promise<void> {
    throw new Error("FakeDriver.connect: not used by EventReader");
  }
  async close(): Promise<void> {
    throw new Error("FakeDriver.close: not used by EventReader");
  }
  async disconnect(): Promise<void> {
    throw new Error("FakeDriver.disconnect: not used by EventReader");
  }
}

class FakePipeline implements PipelineBuilder {
  private readonly behavior: PipelineResult | "throw" | undefined;
  private queued = 0;

  constructor(behavior: PipelineResult | "throw" | undefined) {
    this.behavior = behavior;
  }

  add(_command: string, _args: RedisArg[]): this {
    this.queued++;
    return this;
  }

  async exec(): Promise<PipelineResult> {
    if (this.behavior === "throw") {
      throw new Error("simulated pipeline failure (connection drop)");
    }
    if (Array.isArray(this.behavior)) return this.behavior;
    // No behavior scripted → return enough null slots to cover whatever
    // the caller queued, so applyEnrichment() sees `undefined` fields
    // and emits the event with bare metadata only. Good enough for the
    // "did the handler fire at all" assertion.
    return Array.from({ length: this.queued }, () => [null, null]);
  }
}

describe("EventReader — lastIds advancement on pipeline failure", () => {
  it("replays events from a batch whose pipeline exec failed", async () => {
    const driver = new FakeDriver();

    // Batch 1: two completed events. Enrichment pipeline will THROW on
    // first exec, simulating a mid-batch connection failure after the
    // XREAD response has been parsed but before enrichment commits.
    driver.xreadQueue.push([
      [
        "taskora:{my-task}:events",
        [
          ["0-1", ["event", "completed", "jobId", "job-a"]],
          ["0-2", ["event", "completed", "jobId", "job-b"]],
        ],
      ],
    ]);
    driver.pipelineBehaviors.push("throw");

    // Batch 2 (after 1-second sleep in event-reader's catch handler):
    // The SAME two entries replay because lastIds should NOT have
    // advanced past them. This models a real Redis that will return
    // the same entries when XREAD is called again from the pre-failure
    // cursor position.
    driver.xreadQueue.push([
      [
        "taskora:{my-task}:events",
        [
          ["0-1", ["event", "completed", "jobId", "job-a"]],
          ["0-2", ["event", "completed", "jobId", "job-b"]],
        ],
      ],
    ]);
    // Second exec succeeds — 2 events × 2 commands per completed event
    // (hmget + get) = 4 result slots.
    driver.pipelineBehaviors.push([
      [null, [null, null, null]],
      [null, null],
      [null, [null, null, null]],
      [null, null],
    ]);

    const received: Taskora.StreamEvent[] = [];
    const reader = new EventReader(driver);
    await reader.start(["my-task"], (event) => {
      received.push(event);
    });

    // First failure → 1s sleep → second successful batch. Give it ~2s.
    await new Promise((r) => setTimeout(r, 2_100));
    await reader.stop();

    const jobIds = received.map((e) => e.jobId).sort();
    expect(jobIds).toEqual(["job-a", "job-b"]);

    // Second XREAD MUST have used the pre-failure cursor (whatever the
    // snapshot set it to — "0-0" in this test). If lastIds had been
    // prematurely advanced to "0-2", the second XREAD would ask for
    // entries after "0-2" and the replay would never happen. Check
    // that the cursor did not move forward between calls.
    expect(driver.idsSeen.length).toBeGreaterThanOrEqual(2);
    const firstIds = driver.idsSeen[0];
    const secondIds = driver.idsSeen[1];
    expect(secondIds).toEqual(firstIds);
  });

  it("advances lastIds once a pipeline exec succeeds, to avoid double-delivery", async () => {
    // Flip side: happy path. After a successful batch, the next XREAD
    // must start from the last delivered entry, not replay the batch.
    // This guards against over-correcting the fix — "never advance" is
    // just as broken as "always advance".
    const driver = new FakeDriver();

    driver.xreadQueue.push([
      [
        "taskora:{my-task}:events",
        [
          ["0-5", ["event", "completed", "jobId", "job-x"]],
          ["0-7", ["event", "completed", "jobId", "job-y"]],
        ],
      ],
    ]);
    driver.pipelineBehaviors.push([
      [null, [null, null, null]],
      [null, null],
      [null, [null, null, null]],
      [null, null],
    ]);

    const received: Taskora.StreamEvent[] = [];
    const reader = new EventReader(driver);
    await reader.start(["my-task"], (event) => {
      received.push(event);
    });

    // Wait long enough for the first XREAD to run, enrichment to
    // complete, and the loop to swing around for a second XREAD.
    await new Promise((r) => setTimeout(r, 200));
    await reader.stop();

    expect(received.map((e) => e.jobId).sort()).toEqual(["job-x", "job-y"]);

    // On the second XREAD the cursor must have moved to "0-7" — the
    // latest entry we delivered. Otherwise the handler would see each
    // event twice (or N times if the batch keeps replaying).
    expect(driver.idsSeen.length).toBeGreaterThanOrEqual(2);
    expect(driver.idsSeen[1]).toEqual(["0-7"]);
  });
});
