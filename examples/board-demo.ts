/**
 * taskora/board demo
 *
 * Usage:
 *   1. Start Redis:  docker run -d -p 6379:6379 redis:7-alpine
 *   2. Run this:     bun run examples/board-demo.ts
 *   3. Open:         http://localhost:3000/board/
 */

import { createTaskora } from "../src/index.js";
import { redisAdapter } from "../src/redis/index.js";
import { createBoard } from "../src/board/index.js";

const app = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
  defaults: {
    retry: { attempts: 3, backoff: "exponential", delay: 1000 },
    timeout: 10_000,
  },
});

// ── Define tasks ──────────────────────────────────────────────────

const sendEmail = app.task<{ to: string; subject: string }, { sent: boolean }>(
  "send-email",
  {
    concurrency: 3,
    handler: async (data, ctx) => {
      ctx.log.info(`Sending email to ${data.to}`);
      ctx.progress(50);
      await sleep(random(200, 800));
      ctx.progress(100);

      // 15% chance of failure for demo
      if (Math.random() < 0.15) {
        throw new Error(`SMTP connection refused for ${data.to}`);
      }

      ctx.log.info("Email sent successfully");
      return { sent: true };
    },
  },
);

const processImage = app.task<{ url: string; size: string }, { width: number; height: number }>(
  "process-image",
  {
    concurrency: 2,
    timeout: 5000,
    handler: async (data, ctx) => {
      ctx.log.info(`Processing image: ${data.url} (${data.size})`);
      ctx.progress(25);
      await sleep(random(300, 1200));
      ctx.progress(75);
      await sleep(random(100, 400));
      ctx.progress(100);

      // 10% chance of failure
      if (Math.random() < 0.1) {
        throw new Error("Image format not supported");
      }

      return { width: 1920, height: 1080 };
    },
  },
);

const syncData = app.task<{ source: string }, { records: number }>(
  "sync-data",
  {
    concurrency: 1,
    retry: { attempts: 5, backoff: "linear", delay: 2000 },
    handler: async (data, ctx) => {
      ctx.log.info(`Syncing from ${data.source}`);
      const total = random(50, 500);
      for (let i = 0; i <= 10; i++) {
        ctx.progress({ current: i * (total / 10), total, step: `batch ${i}/10` });
        await sleep(random(100, 300));
      }

      // 20% chance of failure for more DLQ content
      if (Math.random() < 0.2) {
        throw new Error(`Connection to ${data.source} timed out`);
      }

      return { records: total };
    },
  },
);

const generateReport = app.task<{ type: string }, string>(
  "generate-report",
  {
    concurrency: 1,
    handler: async (data, ctx) => {
      ctx.log.info(`Generating ${data.type} report`);
      await sleep(random(500, 1500));
      ctx.log.info("Report generated");
      return `report-${data.type}-${Date.now()}.pdf`;
    },
  },
);

// ── Schedule ──────────────────────────────────────────────────────

app.schedule("hourly-sync", {
  task: "sync-data",
  every: "1h",
  data: { source: "api.example.com" },
});

app.schedule("daily-report", {
  task: "generate-report",
  cron: "0 9 * * *",
  data: { type: "daily" },
});

// ── Board ─────────────────────────────────────────────────────────

const board = createBoard(app, {
  basePath: "/board",
  title: "taskora demo",
  theme: "auto",
  redact: ["password", "secret"],
  refreshInterval: 2000,
});

// ── Start ─────────────────────────────────────────────────────────

await app.start();

Bun.serve({
  port: 4000,
  fetch: board.fetch,
});

console.log("");
console.log("  taskora board demo running!");
console.log("");
console.log("  Board:  http://localhost:4000/board/");
console.log("  Redis:  localhost:6379");
console.log("");
console.log("  Dispatching sample jobs every 2-5 seconds...");
console.log("  Press Ctrl+C to stop.");
console.log("");

// ── Dispatch sample jobs in a loop ────────────────────────────────

const emails = ["alice@example.com", "bob@test.org", "charlie@demo.io", "diana@mail.com"];
const images = ["photo.jpg", "banner.png", "avatar.webp", "cover.heic"];
const sizes = ["sm", "md", "lg", "xl"];
const sources = ["api.example.com", "db.staging.internal", "s3://data-lake/raw"];

async function dispatchLoop() {
  while (true) {
    const r = Math.random();

    if (r < 0.4) {
      // Send email
      const to = emails[random(0, emails.length - 1)];
      sendEmail.dispatch({ to, subject: `Hello ${to.split("@")[0]}` });
    } else if (r < 0.7) {
      // Process image
      const url = `https://cdn.example.com/${images[random(0, images.length - 1)]}`;
      processImage.dispatch({ url, size: sizes[random(0, sizes.length - 1)] });
    } else if (r < 0.9) {
      // Sync data
      syncData.dispatch({ source: sources[random(0, sources.length - 1)] });
    } else {
      // Generate report
      generateReport.dispatch({ type: ["daily", "weekly", "monthly"][random(0, 2)] });
    }

    await sleep(random(2000, 5000));
  }
}

dispatchLoop();

// ── Helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function random(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
