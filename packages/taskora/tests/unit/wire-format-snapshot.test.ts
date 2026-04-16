// ─────────────────────────────────────────────────────────────────────────
// Wire-format snapshot — the tripwire for accidental breaking releases.
//
// Everything persisted in the backend (Redis keys, Lua scripts, meta layout)
// is frozen below at WIRE_VERSION=1. Any PR that changes a key name, a Lua
// script body, or the meta key builder will fail this test and get a clear
// "you are touching the wire format" reminder.
//
// This is NOT a cosmetic check — a drifted key or renamed hash field
// silently corrupts production queues. The friction is the point.
//
// If this test fails, the fix is one of:
//
//   (a) You intended the change, and it IS a wire-format change
//       → bump WIRE_VERSION in src/wire-version.ts (+ MIN_COMPAT_VERSION
//         iff it breaks older readers — see docs/WIRE_FORMAT.md tables)
//       → update the frozen values below to match the new reality
//       → update docs/WIRE_FORMAT.md and
//         documentation/operations/upgrading.md if user-visible
//
//   (b) You did NOT intend the change (e.g. you only tweaked whitespace or
//       a comment in a Lua script) → revert the source change. The wire
//       format is load-bearing; drive-by edits are not allowed.
//
// Do NOT "fix" this test by blindly copy-pasting the new hashes without
// reading the diff. That defeats the entire mechanism.
// ─────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildKeys, buildMetaKey, buildScheduleKeys } from "../../src/redis/keys.js";
import * as scripts from "../../src/redis/scripts.js";
import * as workflowScripts from "../../src/redis/workflow-scripts.js";
import { MIN_COMPAT_VERSION, WIRE_VERSION } from "../../src/wire-version.js";

function sha(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function collectScriptHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, source] of Object.entries({ ...scripts, ...workflowScripts })) {
    if (typeof source === "string") {
      out[name] = sha(source);
    }
  }
  // Deterministic ordering so additions/removals show up clearly in diffs.
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

// ── The frozen surface ──────────────────────────────────────────────────

const FROZEN_AT_WIRE_VERSION = 6;

// buildKeys / buildMetaKey / buildScheduleKeys output for fixed inputs. These
// strings are persisted in live Redis instances — renaming ANY of them is a
// breaking wire change.
const FROZEN_KEY_LAYOUT = {
  job: {
    wait: "taskora:{sample-task}:wait",
    prioritized: "taskora:{sample-task}:prioritized",
    active: "taskora:{sample-task}:active",
    delayed: "taskora:{sample-task}:delayed",
    completed: "taskora:{sample-task}:completed",
    failed: "taskora:{sample-task}:failed",
    expired: "taskora:{sample-task}:expired",
    cancelled: "taskora:{sample-task}:cancelled",
    cancelChannel: "taskora:{sample-task}:cancel",
    events: "taskora:{sample-task}:events",
    stalled: "taskora:{sample-task}:stalled",
    marker: "taskora:{sample-task}:marker",
    jobPrefix: "taskora:{sample-task}:",
  },
  jobWithPrefix: {
    wait: "taskora:myapp:{sample-task}:wait",
    prioritized: "taskora:myapp:{sample-task}:prioritized",
    active: "taskora:myapp:{sample-task}:active",
    delayed: "taskora:myapp:{sample-task}:delayed",
    completed: "taskora:myapp:{sample-task}:completed",
    failed: "taskora:myapp:{sample-task}:failed",
    expired: "taskora:myapp:{sample-task}:expired",
    cancelled: "taskora:myapp:{sample-task}:cancelled",
    cancelChannel: "taskora:myapp:{sample-task}:cancel",
    events: "taskora:myapp:{sample-task}:events",
    stalled: "taskora:myapp:{sample-task}:stalled",
    marker: "taskora:myapp:{sample-task}:marker",
    jobPrefix: "taskora:myapp:{sample-task}:",
  },
  meta: "taskora:meta",
  metaWithPrefix: "taskora:tenant-a:meta",
  schedules: {
    schedules: "taskora:schedules",
    schedulesNext: "taskora:schedules:next",
    schedulerLock: "taskora:schedules:lock",
  },
  schedulesWithPrefix: {
    schedules: "taskora:myapp:schedules",
    schedulesNext: "taskora:myapp:schedules:next",
    schedulerLock: "taskora:myapp:schedules:lock",
  },
};

// SHA256 prefixes of every Lua script in the backend, alphabetical. A single
// whitespace or comment edit in any script flips its hash, which is by
// design — reviewers must consciously acknowledge every Lua change rather
// than let a drive-by edit slip through.
const FROZEN_SCRIPT_HASHES: Record<string, string> = {
  ACK: "b32ce5bea037561b",
  ACK_AND_MOVE_TO_ACTIVE: "528e9499e74f04c2",
  ACQUIRE_SCHEDULER_LOCK: "362180a86b49ee72",
  ADVANCE_WORKFLOW: "b3535a40f566e08e",
  CANCEL: "dd2fac08671df39f",
  CANCEL_WORKFLOW: "409298974cb9f05e",
  CLEAN_JOBS: "3e41dd29bccf2a5c",
  COLLECT_PUSH: "d7ab6db82b1ffa5d",
  CREATE_WORKFLOW: "e32df6d810b9ad4e",
  DEBOUNCE: "8d9dde44713a9891",
  DEDUPLICATE_ENQUEUE: "8a6ca60de6dbdb7c",
  ENQUEUE: "6e1a57efb6f1d142",
  ENQUEUE_BULK: "b1a0823e656cdb86",
  ENQUEUE_DELAYED: "609c1e2014ce9d6d",
  EXTEND_LOCK: "dc500d7199ee06b1",
  FAIL: "b733a38465348cb8",
  FAIL_AND_MOVE_TO_ACTIVE: "671d1bf695b6dd4f",
  FAIL_WORKFLOW: "a7762af2ff385164",
  FINISH_CANCEL: "5f78f671ea104896",
  HANDSHAKE: "91898f9a4c4cf5b7",
  LIST_JOB_DETAILS: "d2db7d0f20cadddf",
  MIGRATE_JOBS_V5_TO_V6: "68ac319cf64ff94f",
  MIGRATE_WAIT_V1_TO_V2: "dd1209f915452b05",
  MIGRATE_WAIT_V4_TO_V5: "a6772e24095d3e43",
  MOVE_TO_ACTIVE: "bfa78047822b82d8",
  NACK: "65f2aa38487f6c59",
  RENEW_SCHEDULER_LOCK: "96d3ba1e2ef947b6",
  RETRY_ALL_DLQ: "a85b332ac5d98193",
  RETRY_DLQ: "a5ec711e00cfe252",
  STALLED_CHECK: "9f6c5cf36b54fe09",
  THROTTLE_ENQUEUE: "eba402f084edf5f0",
  TICK_SCHEDULER: "d77ed41b08630ef8",
  TRIM_DLQ: "d0d60a045c8c87e8",
  VERSION_DISTRIBUTION: "37905d283ee71f59",
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("wire format snapshot", () => {
  it("is frozen at the version this test was written against", () => {
    // Sanity check: if WIRE_VERSION was bumped but the snapshot wasn't
    // reviewed, this fires first with a clearer message than the others.
    expect(WIRE_VERSION).toBe(FROZEN_AT_WIRE_VERSION);
  });

  it("MIN_COMPAT_VERSION is a valid window edge", () => {
    expect(Number.isInteger(MIN_COMPAT_VERSION)).toBe(true);
    expect(MIN_COMPAT_VERSION).toBeGreaterThanOrEqual(1);
    expect(MIN_COMPAT_VERSION).toBeLessThanOrEqual(WIRE_VERSION);
  });

  it("redis key layout matches the frozen surface", () => {
    const actual = {
      job: buildKeys("sample-task"),
      jobWithPrefix: buildKeys("sample-task", "myapp"),
      meta: buildMetaKey(),
      metaWithPrefix: buildMetaKey("tenant-a"),
      schedules: buildScheduleKeys(),
      schedulesWithPrefix: buildScheduleKeys("myapp"),
    };

    // If this assertion fails the error will surface the specific key that
    // drifted. Do NOT change FROZEN_KEY_LAYOUT without also bumping
    // WIRE_VERSION — see the file header.
    expect(actual).toEqual(FROZEN_KEY_LAYOUT);
  });

  it("Lua script hashes match the frozen surface", () => {
    const actual = collectScriptHashes();

    // Compare the set of script names first so the error message points at
    // additions/removals separately from content edits.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(FROZEN_SCRIPT_HASHES).sort());

    // Then compare content hashes. Any single Lua edit trips this.
    expect(actual).toEqual(FROZEN_SCRIPT_HASHES);
  });
});
