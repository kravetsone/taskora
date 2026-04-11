import type { OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import type { App } from "taskora";

export class TaskoraLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly app: App,
    private readonly autoStart: boolean,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.autoStart) await this.app.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.app.close();
  }
}
