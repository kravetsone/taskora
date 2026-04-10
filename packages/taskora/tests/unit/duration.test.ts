import { describe, expect, it } from "vitest";
import { parseDuration } from "../../src/scheduler/duration.js";

describe("parseDuration", () => {
  it("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1s")).toBe(1_000);
    expect(parseDuration("0.5s")).toBe(500);
  });

  it("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1m")).toBe(60_000);
  });

  it("parses hours", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("parses days", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
  });

  it("passes through numbers (ms)", () => {
    expect(parseDuration(5000)).toBe(5000);
    expect(parseDuration(1)).toBe(1);
  });

  it("throws on invalid string format", () => {
    expect(() => parseDuration("abc" as never)).toThrow("Invalid duration");
    expect(() => parseDuration("30" as never)).toThrow("Invalid duration");
    expect(() => parseDuration("30x" as never)).toThrow("Invalid duration");
    expect(() => parseDuration("" as never)).toThrow("Invalid duration");
  });

  it("throws on zero or negative number", () => {
    expect(() => parseDuration(0)).toThrow("must be a positive");
    expect(() => parseDuration(-1)).toThrow("must be a positive");
  });

  it("throws on non-finite number", () => {
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow("must be a positive finite");
    expect(() => parseDuration(Number.NaN)).toThrow("must be a positive finite");
  });
});
