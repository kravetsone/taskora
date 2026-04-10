/**
 * taskora/board demo — rich scenario
 *
 * Usage:
 *   1. Start Redis:  docker run -d -p 6379:6379 redis:7-alpine
 *   2. Run this:     bun run examples/board-demo.ts
 *   3. Open:         http://localhost:4000/board/
 *   4. Sign in:      admin / demo
 */

import { chain, chord, createTaskora, group } from "taskora";
import { createBoard } from "taskora/board";
import { redisAdapter } from "taskora/redis";

const app = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
  defaults: {
    retry: { attempts: 3, backoff: "exponential", delay: 500 },
    timeout: 15_000,
  },
});

// ══════════════════════════════════════════════════════════════════
// Tasks — each with different failure/delay characteristics
// ══════════════════════════════════════════════════════════════════

// Fast task, rarely fails — lots of completed
const sendEmail = app.task<{ to: string; subject: string }, { sent: boolean }>("send-email", {
  concurrency: 5,
  handler: async (data, ctx) => {
    ctx.log.info(`Sending to ${data.to}: "${data.subject}"`);
    ctx.progress(30);
    await sleep(random(100, 400));
    ctx.progress(80);
    await sleep(random(50, 150));
    ctx.progress(100);
    if (Math.random() < 0.08) throw new Error(`SMTP refused: ${data.to}`);
    return { sent: true };
  },
});

// Slow task, moderate failures — builds up active count
const processImage = app.task<{ url: string; size: string }, { w: number; h: number }>(
  "process-image",
  {
    concurrency: 2,
    timeout: 8000,
    retry: { attempts: 2, backoff: "fixed", delay: 2000 },
    handler: async (data, ctx) => {
      ctx.log.info(`Processing: ${data.url} @ ${data.size}`);
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        ctx.progress(Math.round((i / steps) * 100));
        await sleep(random(400, 1500));
      }
      if (Math.random() < 0.25) throw new Error("Image corrupt or unsupported format");
      return { w: 1920, h: 1080 };
    },
  },
);

// Bulk task — dispatched with delays, fills delayed queue
const syncData = app.task<{ source: string; batch: number }, { records: number }>("sync-data", {
  concurrency: 1,
  retry: { attempts: 5, backoff: "linear", delay: 3000 },
  handler: async (data, ctx) => {
    ctx.log.info(`Syncing batch ${data.batch} from ${data.source}`);
    const total = random(100, 1000);
    for (let i = 0; i <= 10; i++) {
      ctx.progress({ current: Math.round(i * (total / 10)), total, step: `page ${i}/10` });
      await sleep(random(200, 600));
    }
    if (Math.random() < 0.35) throw new Error(`Timeout connecting to ${data.source}`);
    return { records: total };
  },
});

// Ultra-flaky — most fail permanently, fills DLQ
const webhookDelivery = app.task<{ url: string; payload: string }, void>("webhook-delivery", {
  concurrency: 3,
  retry: { attempts: 3, backoff: "exponential", delay: 1000 },
  ttl: { max: "10s", onExpire: "fail" },
  handler: async (data, ctx) => {
    ctx.log.info(`POST ${data.url}`);
    await sleep(random(200, 800));
    // 60% fail — lots of retries then DLQ
    if (Math.random() < 0.6) throw new Error(`HTTP 503 from ${data.url}`);
    ctx.log.info("Delivered OK");
  },
});

// Report generation — slow, always succeeds
const generateReport = app.task<{ type: string; period: string }, string>("generate-report", {
  concurrency: 1,
  handler: async (data, ctx) => {
    ctx.log.info(`Generating ${data.period} ${data.type} report...`);
    ctx.progress(10);
    await sleep(random(1000, 3000));
    ctx.progress(50);
    await sleep(random(500, 1500));
    ctx.progress(90);
    await sleep(random(200, 500));
    ctx.progress(100);
    ctx.log.info("Report ready");
    return `report-${data.type}-${data.period}-${Date.now()}.pdf`;
  },
});

// Workflow step tasks — used in chains/groups/chords
const resize = app.task<{ url: string; width: number }, { url: string }>("resize", {
  concurrency: 3,
  handler: async (data, ctx) => {
    ctx.log.info(`Resizing ${data.url} to ${data.width}px`);
    await sleep(random(300, 800));
    if (Math.random() < 0.1) throw new Error("Out of memory during resize");
    return { url: `${data.url}?w=${data.width}` };
  },
});

const watermark = app.task<{ url: string }, { url: string }>("watermark", {
  concurrency: 3,
  handler: async (data, ctx) => {
    ctx.log.info(`Watermarking ${data.url}`);
    await sleep(random(200, 600));
    return { url: `${data.url}&wm=1` };
  },
});

const uploadCDN = app.task<{ url: string }, { cdnUrl: string }>("upload-cdn", {
  concurrency: 2,
  handler: async (data, ctx) => {
    ctx.log.info(`Uploading to CDN: ${data.url}`);
    await sleep(random(500, 1200));
    if (Math.random() < 0.15) throw new Error("CDN upload timeout");
    return { cdnUrl: `https://cdn.example.com/${Date.now()}.jpg` };
  },
});

const notify = app.task<{ cdnUrl: string }, void>("notify", {
  concurrency: 5,
  handler: async (data, ctx) => {
    ctx.log.info(`Notifying about ${data.cdnUrl}`);
    await sleep(random(100, 300));
  },
});

// Chord callback — receives tuple of results
const aggregate = app.task<any, { count: number }>("aggregate", {
  concurrency: 1,
  handler: async (data, ctx) => {
    ctx.log.info(`Aggregating ${data.length} results`);
    await sleep(random(300, 600));
    return { count: data.length };
  },
});

// ══════════════════════════════════════════════════════════════════
// Schedules
// ══════════════════════════════════════════════════════════════════

app.schedule("daily-report", {
  task: "generate-report",
  cron: "0 9 * * *",
  data: { type: "summary", period: "daily" },
});

app.schedule("weekly-report", {
  task: "generate-report",
  cron: "0 10 * * 1",
  data: { type: "analytics", period: "weekly" },
});

app.schedule("sync-every-30m", {
  task: "sync-data",
  every: "30m",
  data: { source: "api.example.com", batch: 0 },
});

// ══════════════════════════════════════════════════════════════════
// Board
// ══════════════════════════════════════════════════════════════════

// Demo credentials — username "admin", password "demo".
// In production, read these from env vars and store the cookie secret in a
// secret manager. `openssl rand -base64 48` is a good source for cookiePassword.
const DEMO_USERNAME = "admin";
const DEMO_PASSWORD = "demo";
const DEMO_COOKIE_SECRET =
  process.env.BOARD_COOKIE_SECRET ?? "demo-demo-demo-demo-demo-demo-demo-demo-demo-demo";

const board = createBoard(app, {
  basePath: "/board",
  title: "taskora demo",
  theme: "auto",
  redact: ["password", "secret", "token"],
  refreshInterval: 2000,
  auth: {
    cookiePassword: DEMO_COOKIE_SECRET,
    authenticate: async ({ username, password }) => {
      if (username === DEMO_USERNAME && password === DEMO_PASSWORD) {
        return { id: "admin", name: "Demo admin" };
      }
      return null;
    },
  },
});

// ══════════════════════════════════════════════════════════════════
// Start
// ══════════════════════════════════════════════════════════════════

await app.start();

Bun.serve({ port: 4000, fetch: board.fetch });

console.log("");
console.log("  taskora board demo running!");
console.log("  Board:  http://localhost:4000/board/");
console.log(`  Login:  ${DEMO_USERNAME} / ${DEMO_PASSWORD}`);
console.log("");

// ══════════════════════════════════════════════════════════════════
// Dispatch loops — create varied, interesting state
// ══════════════════════════════════════════════════════════════════

const emails = [
  "alice@co.com",
  "bob@io.dev",
  "charlie@test.org",
  "diana@mail.co",
  "eve@startup.io",
];
const images = ["photo.jpg", "banner.png", "avatar.webp", "hero.heic", "thumb.gif"];
const sizes = ["sm", "md", "lg", "xl"];
const webhookUrls = [
  "https://hooks.slack.com/abc",
  "https://api.partner.com/webhook",
  "https://n8n.internal/hook/123",
  "https://zapier.com/hooks/catch/456",
];
const sources = ["api.example.com", "db.staging.internal", "s3://data-lake", "kafka://events"];

// 1. Email burst — fast, lots of completed
async function emailLoop() {
  while (true) {
    // Burst of 3-6 emails
    const burst = random(3, 6);
    for (let i = 0; i < burst; i++) {
      const to = emails[random(0, emails.length - 1)];
      sendEmail.dispatch({ to, subject: `Order #${random(1000, 9999)} confirmed` });
    }
    await sleep(random(1000, 3000));
  }
}

// 2. Image processing — slow, builds active queue
async function imageLoop() {
  while (true) {
    const url = `https://uploads.example.com/${images[random(0, images.length - 1)]}`;
    processImage.dispatch({ url, size: sizes[random(0, sizes.length - 1)] });
    await sleep(random(2000, 5000));
  }
}

// 3. Sync — dispatched with delays, fills delayed queue
async function syncLoop() {
  let batch = 1;
  while (true) {
    const source = sources[random(0, sources.length - 1)];
    // Dispatch some with delay to fill delayed queue
    syncData.dispatch({ source, batch }, { delay: random(0, 1) > 0.5 ? random(5000, 30000) : 0 });
    batch++;
    await sleep(random(4000, 10000));
  }
}

// 4. Webhooks — ultra flaky, fills DLQ fast
async function webhookLoop() {
  while (true) {
    const url = webhookUrls[random(0, webhookUrls.length - 1)];
    webhookDelivery.dispatch({
      url,
      payload: `{"event":"order.created","id":${random(1, 99999)}}`,
    });
    await sleep(random(1500, 4000));
  }
}

// 5. Workflow: chain — resize → watermark → upload-cdn → notify
async function chainLoop() {
  while (true) {
    const url = `https://uploads.example.com/${images[random(0, images.length - 1)]}`;
    const pipeline = chain(resize.s({ url, width: 800 }), watermark.s(), uploadCDN.s(), notify.s());
    pipeline.dispatch({ name: "image-pipeline" });
    await sleep(random(8000, 15000));
  }
}

// 6. Workflow: group — parallel resize to multiple sizes
async function groupLoop() {
  while (true) {
    const url = `https://uploads.example.com/${images[random(0, images.length - 1)]}`;
    const parallel = group(
      resize.s({ url, width: 200 }),
      resize.s({ url, width: 800 }),
      resize.s({ url, width: 1600 }),
    );
    parallel.dispatch({ name: "multi-size-resize" });
    await sleep(random(12000, 25000));
  }
}

// 7. Workflow: chord — resize 3 sizes in parallel, then aggregate
async function chordLoop() {
  while (true) {
    const url = `https://uploads.example.com/${images[random(0, images.length - 1)]}`;
    const batch = chord(
      [
        resize.s({ url, width: 200 }),
        resize.s({ url, width: 800 }),
        resize.s({ url, width: 1600 }),
      ],
      aggregate.s(),
    );
    batch.dispatch({ name: "resize-and-aggregate" });
    await sleep(random(15000, 30000));
  }
}

// 8. Reports on-demand (occasional)
async function reportLoop() {
  while (true) {
    const types = ["summary", "analytics", "billing", "usage"];
    const periods = ["daily", "weekly", "monthly"];
    generateReport.dispatch({
      type: types[random(0, types.length - 1)],
      period: periods[random(0, periods.length - 1)],
    });
    await sleep(random(15000, 30000));
  }
}

// Launch all loops
emailLoop();
imageLoop();
syncLoop();
webhookLoop();
chainLoop();
groupLoop();
chordLoop();
reportLoop();

console.log("  Dispatching diverse workload...");
console.log("  - emails (burst, fast)");
console.log("  - images (slow, builds active)");
console.log("  - syncs (delayed, flaky)");
console.log("  - webhooks (very flaky, fills DLQ)");
console.log("  - workflows: chain, group, chord");
console.log("  - reports (slow, reliable)");
console.log("  Press Ctrl+C to stop.");
console.log("");

// ── Helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function random(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
