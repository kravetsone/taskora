import { Redis } from "ioredis";
import type { RedisOptions } from "ioredis";
import type {
  PipelineBuilder,
  PipelineResult,
  RedisArg,
  RedisDriver,
  Unsubscribe,
  XReadResult,
} from "../driver.js";

/**
 * `RedisDriver` implementation backed by ioredis.
 *
 * The class is intentionally a thin wrapper: most methods forward to the matching
 * ioredis API. The only non-trivial logic is `evalSha`'s NOSCRIPT recovery and the
 * connection state-machine handling in `connect()` (ioredis exposes a `wait → connecting
 * → ready → ...` lifecycle that we need to abstract over).
 *
 * Connection ownership is decided by the factory (`src/redis/ioredis.ts`), not here.
 */
export class IoredisDriver implements RedisDriver {
  private readonly client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  // Exposed for the factory to detect status without leaking ioredis types upstream.
  get raw(): Redis {
    return this.client;
  }

  async command(name: string, args: RedisArg[]): Promise<unknown> {
    // ioredis's `call()` accepts a string command + args; numeric/binary args
    // pass through unchanged.
    return this.client.call(name, ...(args as (string | number | Buffer)[]));
  }

  pipeline(): PipelineBuilder {
    return new IoredisPipelineBuilder(this.client);
  }

  async scriptLoad(source: string): Promise<string> {
    return (await this.client.script("LOAD", source)) as string;
  }

  async evalSha(
    sha: string,
    numKeys: number,
    args: RedisArg[],
    fallbackSource: string,
  ): Promise<unknown> {
    try {
      return await this.client.evalsha(sha, numKeys, ...(args as (string | number | Buffer)[]));
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("NOSCRIPT")) {
        // Server's script cache lost the SHA — re-EVAL with the source and re-load.
        const result = await this.client.eval(
          fallbackSource,
          numKeys,
          ...(args as (string | number | Buffer)[]),
        );
        // Best-effort re-load so subsequent EVALSHA calls hit the cache again.
        // We don't update any external SHA mapping here — that's the backend's
        // responsibility (it caches by script name, not SHA value).
        await this.client.script("LOAD", fallbackSource).catch(() => undefined);
        return result;
      }
      throw err;
    }
  }

  async blockingZPopMin(key: string, timeoutSec: number): Promise<[string, string, string] | null> {
    const result = (await this.client.bzpopmin(key, timeoutSec)) as [string, string, string] | null;
    return result ?? null;
  }

  async blockingXRead(
    streams: string[],
    ids: string[],
    blockMs: number,
    count: number,
  ): Promise<XReadResult | null> {
    // Routed through `call()` rather than `client.xread()` because ioredis's
    // typed `xread` overloads don't accept the variadic `BLOCK + COUNT + STREAMS`
    // form cleanly. The wire protocol is identical.
    const result = (await this.client.call(
      "XREAD",
      "BLOCK",
      String(blockMs),
      "COUNT",
      String(count),
      "STREAMS",
      ...streams,
      ...ids,
    )) as XReadResult | null;
    return result ?? null;
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<Unsubscribe> {
    await this.client.subscribe(channel);
    const onMessage = (_channel: string, message: string) => {
      handler(message);
    };
    this.client.on("message", onMessage);

    return async () => {
      this.client.off("message", onMessage);
      try {
        await this.client.unsubscribe(channel);
      } catch {
        // Already disconnected
      }
    };
  }

  async duplicate(): Promise<RedisDriver> {
    const dup = this.client.duplicate();
    // Match the lazyConnect behavior of the original (ioredis's duplicate inherits options).
    if (dup.status === "wait") {
      await dup.connect();
    } else if (dup.status !== "ready") {
      await new Promise<void>((resolve, reject) => {
        dup.once("ready", resolve);
        dup.once("error", reject);
      });
    }
    return new IoredisDriver(dup);
  }

  async connect(): Promise<void> {
    const { status } = this.client;
    if (status === "wait") {
      await this.client.connect();
    } else if (status !== "ready") {
      await new Promise<void>((resolve, reject) => {
        this.client.once("ready", resolve);
        this.client.once("error", reject);
      });
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // Already closed; fall through.
    }
  }

  async disconnect(): Promise<void> {
    // Immediate, non-graceful socket close. Interrupts any pending blocking
    // command (BZPOPMIN, XREAD BLOCK, SUBSCRIBE) without waiting for it to
    // return — critical for clean shutdown of worker/event-reader/job-waiter.
    this.client.disconnect(false);
  }
}

class IoredisPipelineBuilder implements PipelineBuilder {
  private readonly pipe: ReturnType<Redis["pipeline"]>;

  constructor(client: Redis) {
    this.pipe = client.pipeline();
  }

  add(command: string, args: RedisArg[]): this {
    // ioredis's pipeline accepts arbitrary commands via the array form.
    // The numeric arg coercion happens server-side; we pass through.
    (this.pipe as unknown as { call: (cmd: string, ...args: unknown[]) => void }).call(
      command,
      ...args,
    );
    return this;
  }

  async exec(): Promise<PipelineResult> {
    const result = (await this.pipe.exec()) as PipelineResult | null;
    return result ?? [];
  }
}

/**
 * Construct an `IoredisDriver` from any of: a connection URL string, an `RedisOptions`
 * config object, or a pre-built `Redis` instance. Returns the driver and an `ownsClient`
 * flag the factory uses to decide whether `close()` should call `quit()`.
 */
export function createIoredisDriver(connection: string | RedisOptions | Redis): {
  driver: IoredisDriver;
  ownsClient: boolean;
} {
  if (connection instanceof Redis) {
    return { driver: new IoredisDriver(connection), ownsClient: false };
  }
  if (typeof connection === "string") {
    return {
      driver: new IoredisDriver(new Redis(connection, { lazyConnect: true })),
      ownsClient: true,
    };
  }
  return {
    driver: new IoredisDriver(new Redis({ ...connection, lazyConnect: true })),
    ownsClient: true,
  };
}
