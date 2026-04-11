import { Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { App } from "taskora";
import { memoryAdapter } from "taskora/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InjectApp, TaskoraModule, type TaskoraModuleOptionsFactory } from "../src/index.js";

@Injectable()
class AppConsumer {
  constructor(@InjectApp() readonly app: App) {}
}

@Injectable()
class NamedAppConsumer {
  constructor(
    @InjectApp() readonly defaultApp: App,
    @InjectApp("secondary") readonly secondaryApp: App,
  ) {}
}

describe("TaskoraModule.forRoot", () => {
  let startSpy: ReturnType<typeof vi.spyOn>;
  let closeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    startSpy = vi.spyOn(App.prototype, "start");
    closeSpy = vi.spyOn(App.prototype, "close");
  });

  afterEach(() => {
    startSpy.mockRestore();
    closeSpy.mockRestore();
  });

  it("provides the App via @InjectApp()", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter() })],
      providers: [AppConsumer],
    }).compile();

    await moduleRef.init();
    try {
      expect(moduleRef.get(AppConsumer).app).toBeInstanceOf(App);
    } finally {
      await moduleRef.close();
    }
  });

  it("calls app.start() on bootstrap and app.close() on shutdown", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter() })],
    }).compile();

    moduleRef.enableShutdownHooks();

    await moduleRef.init();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();

    await moduleRef.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("honours autoStart: false by skipping the start() call", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({
          adapter: memoryAdapter(),
          autoStart: false,
        }),
      ],
    }).compile();

    await moduleRef.init();
    try {
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      await moduleRef.close();
    }
  });

  it("isolates named app slots", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({ adapter: memoryAdapter() }),
        TaskoraModule.forRoot({ name: "secondary", adapter: memoryAdapter() }),
      ],
      providers: [NamedAppConsumer],
    }).compile();

    await moduleRef.init();
    try {
      const consumer = moduleRef.get(NamedAppConsumer);
      expect(consumer.defaultApp).toBeInstanceOf(App);
      expect(consumer.secondaryApp).toBeInstanceOf(App);
      expect(consumer.defaultApp).not.toBe(consumer.secondaryApp);
    } finally {
      await moduleRef.close();
    }
  });
});

describe("TaskoraModule.forRootAsync", () => {
  it("resolves options via useFactory with injected dependencies", async () => {
    @Injectable()
    class ConfigStub {
      readonly adapter = memoryAdapter();
    }

    @Module({ providers: [ConfigStub], exports: [ConfigStub] })
    class ConfigModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRootAsync({
          imports: [ConfigModule],
          useFactory: (cfg: ConfigStub) => ({ adapter: cfg.adapter }),
          inject: [ConfigStub],
        }),
      ],
      providers: [AppConsumer],
    }).compile();

    await moduleRef.init();
    try {
      expect(moduleRef.get(AppConsumer).app).toBeInstanceOf(App);
    } finally {
      await moduleRef.close();
    }
  });

  it("resolves options via useClass", async () => {
    @Injectable()
    class OptionsProvider implements TaskoraModuleOptionsFactory {
      createTaskoraOptions() {
        return { adapter: memoryAdapter() };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRootAsync({ useClass: OptionsProvider })],
      providers: [AppConsumer],
    }).compile();

    await moduleRef.init();
    try {
      expect(moduleRef.get(AppConsumer).app).toBeInstanceOf(App);
    } finally {
      await moduleRef.close();
    }
  });
});
