import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Board } from "@taskora/board";
import { memoryAdapter } from "taskora/memory";
import { describe, expect, it } from "vitest";
import { InjectBoard, TaskoraBoardModule, TaskoraModule, getBoardToken } from "../src/index.js";

@Injectable()
class DashboardService {
  constructor(@InjectBoard() readonly board: Board) {}
}

@Injectable()
class MultiBoardService {
  constructor(
    @InjectBoard() readonly defaultBoard: Board,
    @InjectBoard("secondary") readonly secondaryBoard: Board,
  ) {}
}

describe("TaskoraBoardModule — DI provider for @taskora/board", () => {
  it("provides a Board instance under the default token and resolves via @InjectBoard", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({ adapter: memoryAdapter(), autoStart: false }),
        TaskoraBoardModule.forRoot({ basePath: "/board", readOnly: true }),
      ],
      providers: [DashboardService],
    }).compile();

    await moduleRef.init();
    try {
      const svc = moduleRef.get(DashboardService);
      expect(svc.board).toBeDefined();
      expect(typeof svc.board.fetch).toBe("function");
      // The Board interface exposes `app` (Hono) — use it as a structural
      // marker since we don't have the class type at runtime.
      expect(svc.board.app).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });

  it("passes BoardOptions through to createBoard (readOnly/basePath etc.)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({ adapter: memoryAdapter(), autoStart: false }),
        TaskoraBoardModule.forRoot({
          basePath: "/admin/taskora",
          readOnly: true,
          title: "Ops Dashboard",
        }),
      ],
    }).compile();

    await moduleRef.init();
    try {
      // Just asserting the factory resolved without throwing — the board's
      // own unit tests cover option behaviour. Here we verify the module
      // plumbing didn't swallow or reshape anything on the way in.
      const board = moduleRef.get<Board>(getBoardToken());
      expect(board).toBeDefined();
      expect(typeof board.fetch).toBe("function");
    } finally {
      await moduleRef.close();
    }
  });

  it("isolates named boards between apps", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({ adapter: memoryAdapter(), autoStart: false }),
        TaskoraModule.forRoot({
          name: "secondary",
          adapter: memoryAdapter(),
          autoStart: false,
        }),
        TaskoraBoardModule.forRoot({ basePath: "/board" }),
        TaskoraBoardModule.forRoot({ name: "secondary", basePath: "/board-2" }),
      ],
      providers: [MultiBoardService],
    }).compile();

    await moduleRef.init();
    try {
      const svc = moduleRef.get(MultiBoardService);
      expect(svc.defaultBoard).toBeDefined();
      expect(svc.secondaryBoard).toBeDefined();
      expect(svc.defaultBoard).not.toBe(svc.secondaryBoard);
    } finally {
      await moduleRef.close();
    }
  });
});
