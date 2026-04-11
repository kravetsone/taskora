import { describe, expect, it } from "vitest";
import { TaskoraModule } from "../src/index.js";

describe("@taskora/nestjs skeleton", () => {
  it("exports the TaskoraModule façade", () => {
    expect(typeof TaskoraModule).toBe("function");
    expect(typeof TaskoraModule.forRoot).toBe("function");
    expect(typeof TaskoraModule.forRootAsync).toBe("function");
  });

  it("can import taskora through the workspace link", async () => {
    const taskora = await import("taskora");
    expect(typeof taskora.createTaskora).toBe("function");
  });
});
