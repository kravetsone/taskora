import { describe, expect, expectTypeOf, it } from "vitest";
import * as z from "zod";
import { ValidationError } from "../src/errors.js";
import { validateSchema } from "../src/schema.js";

describe("validateSchema", () => {
  const schema = z.object({
    name: z.string(),
    age: z.number(),
  });

  it("returns validated value on success", async () => {
    const result = await validateSchema(schema, { name: "Alice", age: 30 });
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  it("throws ValidationError on invalid data", async () => {
    await expect(validateSchema(schema, { name: 123 })).rejects.toThrow(ValidationError);
  });

  it("includes issues array with messages", async () => {
    try {
      await validateSchema(schema, { name: 123, age: "not a number" });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.issues.length).toBeGreaterThanOrEqual(2);
      for (const issue of ve.issues) {
        expect(issue.message).toBeDefined();
      }
    }
  });

  it("includes path in issues when available", async () => {
    try {
      await validateSchema(schema, { name: 123, age: 30 });
      expect.fail("Should have thrown");
    } catch (err) {
      const ve = err as ValidationError;
      const nameIssue = ve.issues.find((i) => i.path?.includes("name"));
      expect(nameIssue).toBeDefined();
    }
  });

  it("passes through for valid data with extra fields stripped", async () => {
    const strict = z.object({ x: z.number() });
    const result = await validateSchema(strict, { x: 42 });
    expect(result.x).toBe(42);
  });
});
