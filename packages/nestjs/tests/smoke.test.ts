import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("@taskora/nestjs skeleton", () => {
  it("exposes a placeholder version constant", () => {
    expect(typeof VERSION).toBe("string");
  });

  it("can import taskora through the workspace link", async () => {
    const taskora = await import("taskora");
    expect(typeof taskora.createTaskora).toBe("function");
  });
});
