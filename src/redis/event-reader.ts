import type { Taskora } from "../types.js";
import type { RedisDriver } from "./driver.js";
import { buildKeys } from "./keys.js";

export class EventReader {
  private readonly driver: RedisDriver;
  private readonly prefix?: string;
  private running = false;
  private lastIds = new Map<string, string>();

  constructor(driver: RedisDriver, prefix?: string) {
    this.driver = driver;
    this.prefix = prefix;
  }

  async start(tasks: string[], handler: (event: Taskora.StreamEvent) => void): Promise<void> {
    this.running = true;

    // Snapshot current stream positions so we don't miss events
    // that arrive between subscribe() and the first XREAD
    for (const task of tasks) {
      const keys = buildKeys(task, this.prefix);
      if (!this.lastIds.has(keys.events)) {
        const last = (await this.driver.command("xrevrange", [
          keys.events,
          "+",
          "-",
          "COUNT",
          "1",
        ])) as Array<[string, string[]]> | null;
        this.lastIds.set(keys.events, last && last.length > 0 ? last[0][0] : "0-0");
      }
    }

    this.poll(tasks, handler);
  }

  async stop(): Promise<void> {
    this.running = false;
    // The driver itself is closed by the caller (`subscribe()` in backend.ts).
  }

  private async poll(
    tasks: string[],
    handler: (event: Taskora.StreamEvent) => void,
  ): Promise<void> {
    const streams: string[] = [];
    const taskByStream = new Map<string, string>();

    for (const task of tasks) {
      const keys = buildKeys(task, this.prefix);
      streams.push(keys.events);
      taskByStream.set(keys.events, task);
    }

    while (this.running) {
      try {
        const ids = streams.map((s) => this.lastIds.get(s) || "$");

        const result = await this.driver.blockingXRead(streams, ids, 5000, 100);

        if (!result) continue;

        for (const [streamKey, entries] of result) {
          const task = taskByStream.get(streamKey);
          if (!task) continue;

          for (const [entryId, fieldArr] of entries) {
            this.lastIds.set(streamKey, entryId);

            const fields: Record<string, string> = {};
            for (let i = 0; i < fieldArr.length; i += 2) {
              fields[fieldArr[i]] = fieldArr[i + 1];
            }

            const event = fields.event;
            const jobId = fields.jobId;
            if (!event || !jobId) continue;

            try {
              await this.enrich(task, jobId, event, fields);
              handler({ task, event, jobId, fields });
            } catch {
              // Individual event processing error — skip this event, continue with next
            }
          }
        }
      } catch {
        if (!this.running) break;
        await sleep(1000);
      }
    }
  }

  private async enrich(
    task: string,
    jobId: string,
    event: string,
    fields: Record<string, string>,
  ): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    const jobKey = `${keys.jobPrefix}${jobId}`;

    switch (event) {
      case "completed": {
        const results = await this.driver
          .pipeline()
          .add("hmget", [jobKey, "attempt", "processedOn", "finishedOn"])
          .add("get", [`${jobKey}:result`])
          .exec();
        const meta = results[0]?.[1] as (string | null)[] | null;
        if (meta) {
          if (meta[0]) fields.attempt = meta[0];
          if (meta[1] && meta[2]) {
            fields.duration = String(Number(meta[2]) - Number(meta[1]));
          }
        }
        const resultVal = results[1]?.[1] as string | null;
        if (resultVal) fields.result = resultVal;
        break;
      }
      case "failed": {
        const meta = (await this.driver.command("hmget", [jobKey, "attempt", "error"])) as (
          | string
          | null
        )[];
        if (meta[0]) fields.attempt = meta[0];
        if (meta[1]) fields.error = meta[1];
        break;
      }
      case "retrying": {
        const error = (await this.driver.command("hget", [jobKey, "error"])) as string | null;
        if (error) fields.error = error;
        break;
      }
      case "active": {
        const attempt = (await this.driver.command("hget", [jobKey, "attempt"])) as string | null;
        if (attempt) fields.attempt = attempt;
        break;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
