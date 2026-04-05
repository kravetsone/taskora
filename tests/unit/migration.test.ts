import { describe, expect, it } from "vitest";
import { normalizeMigrations, resolveVersion, runMigrations } from "../../src/migration.js";

// ── resolveVersion ────────────────────────────────────────────────────

describe("resolveVersion", () => {
  it("no migrate, no version → defaults to version 1, since 1", () => {
    expect(resolveVersion({})).toEqual({ version: 1, since: 1 });
  });

  it("explicit version, no migrate", () => {
    expect(resolveVersion({ version: 3 })).toEqual({ version: 3, since: 1 });
  });

  it("explicit version + since", () => {
    expect(resolveVersion({ version: 5, since: 3 })).toEqual({ version: 5, since: 3 });
  });

  it("tuple migrate → version = since + length (since defaults to 1)", () => {
    const migrate = [(d: unknown) => d, (d: unknown) => d, (d: unknown) => d];
    expect(resolveVersion({ migrate })).toEqual({ version: 4, since: 1 });
  });

  it("tuple migrate + explicit since → version = since + length", () => {
    const migrate = [(d: unknown) => d, (d: unknown) => d];
    expect(resolveVersion({ since: 3, migrate })).toEqual({ version: 5, since: 3 });
  });

  it("tuple migrate ignores explicit version (version derived)", () => {
    const migrate = [(d: unknown) => d];
    expect(resolveVersion({ version: 99, migrate })).toEqual({ version: 2, since: 1 });
  });

  it("record migrate uses explicit version", () => {
    const migrate = { 3: (d: unknown) => d };
    expect(resolveVersion({ version: 5, migrate })).toEqual({ version: 5, since: 1 });
  });

  it("throws if version < since", () => {
    expect(() => resolveVersion({ version: 2, since: 5 })).toThrow(
      "version (2) cannot be less than since (5)",
    );
  });
});

// ── normalizeMigrations ───────────────────────────────────────────────

describe("normalizeMigrations", () => {
  it("undefined → empty map", () => {
    expect(normalizeMigrations(undefined, 1).size).toBe(0);
  });

  it("tuple: index 0 = since→since+1", () => {
    const fn1 = (d: unknown) => d;
    const fn2 = (d: unknown) => d;
    const map = normalizeMigrations([fn1, fn2], 3);
    expect(map.get(3)).toBe(fn1);
    expect(map.get(4)).toBe(fn2);
    expect(map.size).toBe(2);
  });

  it("record: keys are source versions", () => {
    const fn = (d: unknown) => d;
    const map = normalizeMigrations({ 2: fn, 5: fn }, 1);
    expect(map.get(2)).toBe(fn);
    expect(map.get(5)).toBe(fn);
    expect(map.size).toBe(2);
  });
});

// ── runMigrations ─────────────────────────────────────────────────────

describe("runMigrations", () => {
  it("runs migrations in order v1→v2→v3", () => {
    const migrations = new Map<number, (d: unknown) => unknown>();
    migrations.set(1, (d) => ({ ...(d as Record<string, unknown>), step1: true }));
    migrations.set(2, (d) => ({ ...(d as Record<string, unknown>), step2: true }));

    const result = runMigrations({ original: true }, 1, 3, migrations);
    expect(result).toEqual({ original: true, step1: true, step2: true });
  });

  it("skips versions without a migration function (gaps)", () => {
    const migrations = new Map<number, (d: unknown) => unknown>();
    // Only v2→v3 has a migration, v1→v2 is a gap (schema defaults)
    migrations.set(2, (d) => ({ ...(d as Record<string, unknown>), migrated: true }));

    const result = runMigrations({ data: true }, 1, 4, migrations);
    expect(result).toEqual({ data: true, migrated: true });
  });

  it("same version → no-op", () => {
    const migrations = new Map<number, (d: unknown) => unknown>();
    const data = { unchanged: true };
    const result = runMigrations(data, 3, 3, migrations);
    expect(result).toBe(data); // same reference, no transformation
  });

  it("full chain: each migration transforms the data", () => {
    const migrations = new Map<number, (d: unknown) => unknown>();
    migrations.set(1, () => ({ count: 1 }));
    migrations.set(2, (d) => ({ count: (d as { count: number }).count + 1 }));
    migrations.set(3, (d) => ({ count: (d as { count: number }).count + 1, final: true }));

    const result = runMigrations({}, 1, 4, migrations);
    expect(result).toEqual({ count: 3, final: true });
  });
});
