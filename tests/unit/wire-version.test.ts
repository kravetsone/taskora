import { describe, expect, it } from "vitest";
import {
  MIN_COMPAT_VERSION,
  type SchemaMeta,
  WIRE_VERSION,
  checkCompat,
  currentMeta,
  writtenByForWireVersion,
} from "../../src/wire-version.js";

function meta(
  wire: number,
  minCompat: number,
  writtenBy = "test",
  writtenAt = 1_700_000_000_000,
): SchemaMeta {
  return { wireVersion: wire, minCompat, writtenBy, writtenAt };
}

describe("currentMeta", () => {
  it("reports the compiled-in wire version and min-compat", () => {
    const m = currentMeta(12345);
    expect(m.wireVersion).toBe(WIRE_VERSION);
    expect(m.minCompat).toBe(MIN_COMPAT_VERSION);
    expect(m.writtenAt).toBe(12345);
  });

  it("derives writtenBy from WIRE_VERSION, not from package.json", () => {
    // The whole point of deriving writtenBy from the wire version is that
    // a taskora release that doesn't change the format must not change
    // this field either. If someone re-introduces a package-version-tied
    // build id, this test catches it.
    const m = currentMeta(0);
    expect(m.writtenBy).toBe(`taskora-wire-${WIRE_VERSION}`);
    expect(m.writtenBy).toBe(writtenByForWireVersion(WIRE_VERSION));
    expect(m.writtenBy).not.toMatch(/\d+\.\d+\.\d+/); // no semver shape
  });

  it("defaults writtenAt to Date.now()", () => {
    const before = Date.now();
    const m = currentMeta();
    const after = Date.now();
    expect(m.writtenAt).toBeGreaterThanOrEqual(before);
    expect(m.writtenAt).toBeLessThanOrEqual(after);
  });
});

describe("checkCompat", () => {
  it("passes when wire versions are identical", () => {
    const ours = meta(3, 3);
    const theirs = meta(3, 3, "taskora@0.9.0");
    expect(checkCompat(ours, theirs)).toEqual({ ok: true });
  });

  it("passes when the backend is older but within our compat window", () => {
    // ours is v5 but happy to read anything >= v3; Redis was written by v3
    const ours = meta(5, 3);
    const theirs = meta(3, 3, "old-worker");
    expect(checkCompat(ours, theirs)).toEqual({ ok: true });
  });

  it("passes when the backend is newer but promised to stay compatible with us", () => {
    // Redis was last written by v7; that writer promised to keep everything
    // readable back to v5 — which is us. Both windows overlap → ok.
    const ours = meta(5, 5);
    const theirs = meta(7, 5, "future-worker");
    expect(checkCompat(ours, theirs)).toEqual({ ok: true });
  });

  it("fails with theirs_too_new when the backend dropped support for our version", () => {
    // Redis was written by v7 with minCompat=6, we are v5. The newer writer
    // did not promise to stay readable by v5 — refuse to proceed.
    const ours = meta(5, 5);
    const theirs = meta(7, 6, "future-worker");
    const result = checkCompat(ours, theirs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("theirs_too_new");
      expect(result.message).toContain("wireVersion=7");
      expect(result.message).toContain("future-worker");
    }
  });

  it("fails with theirs_too_old when the backend predates our compat window", () => {
    // We are v5 and refuse anything below v4 (minCompat=4). Redis is v3.
    const ours = meta(5, 4);
    const theirs = meta(3, 3, "legacy-worker");
    const result = checkCompat(ours, theirs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("theirs_too_old");
      expect(result.message).toContain("wireVersion=3");
      expect(result.message).toContain("legacy-worker");
    }
  });

  it("fails with invalid_meta on zero wire version", () => {
    const ours = meta(5, 5);
    const theirs = meta(0, 0, "corrupt");
    const result = checkCompat(ours, theirs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_meta");
  });

  it("fails with invalid_meta when minCompat exceeds wireVersion", () => {
    const ours = meta(5, 5);
    const theirs = meta(3, 4, "weird");
    const result = checkCompat(ours, theirs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_meta");
  });

  it("fails with invalid_meta on non-integer fields", () => {
    const ours = meta(5, 5);
    const theirs = { wireVersion: 1.5, minCompat: 1, writtenBy: "x", writtenAt: 0 };
    const result = checkCompat(ours, theirs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_meta");
  });

  it("symmetric window passes when both sides overlap exactly at one version", () => {
    // ours covers [2,5], theirs covers [5,7]; they overlap only at v5.
    // Both ours.wireVersion=5 >= theirs.minCompat=5 and theirs.wireVersion=5 is
    // actually 7 here so we check the condition.
    const ours = meta(5, 2);
    const theirs = meta(7, 5);
    expect(checkCompat(ours, theirs)).toEqual({ ok: true });
  });
});
