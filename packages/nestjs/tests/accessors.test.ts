import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type App, DeadLetterManager, Inspector } from "taskora";
import { memoryAdapter } from "taskora/memory";
import { describe, expect, it } from "vitest";
import {
  InjectDeadLetters,
  InjectInspector,
  InjectSchedules,
  TaskoraModule,
} from "../src/index.js";

@Injectable()
class AccessorConsumer {
  constructor(
    readonly inspector: Inspector,
    readonly deadLetters: DeadLetterManager,
    @InjectSchedules() readonly schedules: App["schedules"],
  ) {}
}

@Injectable()
class NamedAccessorConsumer {
  constructor(
    @InjectInspector("secondary") readonly inspector: Inspector,
    @InjectDeadLetters("secondary") readonly deadLetters: DeadLetterManager,
    @InjectSchedules("secondary") readonly schedules: App["schedules"],
  ) {}
}

describe("@InjectInspector / @InjectDeadLetters / @InjectSchedules", () => {
  it("resolves default-slot accessors via class tokens (zero decorator)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter(), autoStart: false })],
      providers: [AccessorConsumer],
    }).compile();

    await moduleRef.init();
    try {
      const svc = moduleRef.get(AccessorConsumer);
      expect(svc.inspector).toBeInstanceOf(Inspector);
      expect(svc.deadLetters).toBeInstanceOf(DeadLetterManager);
      expect(svc.schedules).toBeDefined();
      expect(typeof svc.schedules.list).toBe("function");
    } finally {
      await moduleRef.close();
    }
  });

  it("isolates accessors between named app slots", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({ adapter: memoryAdapter(), autoStart: false }),
        TaskoraModule.forRoot({
          name: "secondary",
          adapter: memoryAdapter(),
          autoStart: false,
        }),
      ],
      providers: [AccessorConsumer, NamedAccessorConsumer],
    }).compile();

    await moduleRef.init();
    try {
      const defaultSvc = moduleRef.get(AccessorConsumer);
      const namedSvc = moduleRef.get(NamedAccessorConsumer);

      // Distinct instances across apps
      expect(defaultSvc.inspector).not.toBe(namedSvc.inspector);
      expect(defaultSvc.deadLetters).not.toBe(namedSvc.deadLetters);
      expect(defaultSvc.schedules).not.toBe(namedSvc.schedules);

      // But each still the right class
      expect(namedSvc.inspector).toBeInstanceOf(Inspector);
      expect(namedSvc.deadLetters).toBeInstanceOf(DeadLetterManager);
    } finally {
      await moduleRef.close();
    }
  });
});
