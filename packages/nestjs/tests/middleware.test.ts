import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { App, type Taskora, defineTask } from "taskora";
import { memoryAdapter } from "taskora/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TaskConsumer,
  TaskMiddleware,
  type TaskoraMiddleware,
  TaskoraModule,
} from "../src/index.js";

const echoTask = defineTask<{ msg: string }, { msg: string }>({
  name: "middleware-echo-test",
});

describe("TaskoraModule class middleware", () => {
  let useSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useSpy = vi.spyOn(App.prototype, "use");
  });

  afterEach(() => {
    useSpy.mockRestore();
  });

  it("registers a class middleware via forRoot({ middleware })", async () => {
    @TaskMiddleware()
    class AuditMiddleware implements TaskoraMiddleware {
      async use(_ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
        await next();
      }
    }

    @TaskConsumer(echoTask)
    class EchoConsumer {
      async process(data: { msg: string }) {
        return data;
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({
          adapter: memoryAdapter(),
          autoStart: false,
          middleware: [AuditMiddleware],
        }),
      ],
      providers: [AuditMiddleware, EchoConsumer],
    }).compile();

    await moduleRef.init();
    try {
      expect(useSpy).toHaveBeenCalledTimes(1);
      // The first arg to app.use is the bound closure — invoking it should
      // delegate to the AuditMiddleware instance's use() method.
      const registered = useSpy.mock.calls[0][0] as (
        ctx: Taskora.MiddlewareContext,
        next: () => Promise<void>,
      ) => Promise<void>;
      expect(typeof registered).toBe("function");
    } finally {
      await moduleRef.close();
    }
  });

  it("runs the DI-injected middleware instance in order", async () => {
    const order: string[] = [];

    @Injectable()
    class LoggerService {
      log(msg: string) {
        order.push(msg);
      }
    }

    @TaskMiddleware()
    class OuterMiddleware implements TaskoraMiddleware {
      constructor(private readonly logger: LoggerService) {}
      async use(_ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
        this.logger.log("outer:before");
        await next();
        this.logger.log("outer:after");
      }
    }

    @TaskMiddleware()
    class InnerMiddleware implements TaskoraMiddleware {
      constructor(private readonly logger: LoggerService) {}
      async use(_ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
        this.logger.log("inner:before");
        await next();
        this.logger.log("inner:after");
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({
          adapter: memoryAdapter(),
          autoStart: false,
          middleware: [OuterMiddleware, InnerMiddleware],
        }),
      ],
      providers: [LoggerService, OuterMiddleware, InnerMiddleware],
    }).compile();

    await moduleRef.init();
    try {
      // Grab the two registered closures and compose them manually to prove
      // that both receive the DI-managed instance (logger service is
      // injected) and that ordering follows the list order.
      const outer = useSpy.mock.calls[0][0] as (
        ctx: Taskora.MiddlewareContext,
        next: () => Promise<void>,
      ) => Promise<void>;
      const inner = useSpy.mock.calls[1][0] as (
        ctx: Taskora.MiddlewareContext,
        next: () => Promise<void>,
      ) => Promise<void>;

      const ctx = {} as Taskora.MiddlewareContext;
      const handler = async () => {
        order.push("handler");
      };

      // Simulate the onion chain: outer(ctx, () => inner(ctx, handler))
      await outer(ctx, () => inner(ctx, handler));

      expect(order).toEqual([
        "outer:before",
        "inner:before",
        "handler",
        "inner:after",
        "outer:after",
      ]);
    } finally {
      await moduleRef.close();
    }
  });

  it("throws if a middleware class is listed but not provided to the module", async () => {
    @TaskMiddleware()
    class MissingMiddleware implements TaskoraMiddleware {
      async use(_ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
        await next();
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({
          adapter: memoryAdapter(),
          autoStart: false,
          middleware: [MissingMiddleware],
        }),
      ],
      // intentionally NOT providing MissingMiddleware
      providers: [],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(
      /listed in forRoot.*middleware.*no DI instance was found/,
    );
    await moduleRef.close().catch(() => {});
  });
});
