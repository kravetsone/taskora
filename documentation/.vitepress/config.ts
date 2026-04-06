import { defineConfig } from "vitepress"
import { transformerTwoslash } from "@shikijs/vitepress-twoslash"
import UnoCSS from "unocss/vite"
import llms from "vitepress-plugin-llms"
import { packageManagersMarkdownPlugin } from "vitepress-plugin-package-managers"

// Load TypeDoc-generated sidebar — may not exist before first `bun run gen:typedoc`
let typeDocSidebar: Record<string, unknown[]> = {}
try {
  const { default: sidebarItems } = await import(
    // @ts-ignore — generated file, not always present
    "../api/typedoc-sidebar.json",
    { with: { type: "json" } }
  )
  if (Array.isArray(sidebarItems) && sidebarItems.length > 0) {
    typeDocSidebar = {
      "/api/": [
        {
          text: "API Reference",
          link: "/api/",
          items: sidebarItems,
        },
      ],
    }
  }
} catch {
  // Not yet generated — use static fallback in sidebar
}

export default defineConfig({
  title: "Taskora",
  description:
    "The task queue Node.js deserves. TypeScript-first, batteries-included.",

  cleanUrls: true,

  ignoreDeadLinks: [
    /^\/api\//,
    (link: string) =>
      /^\.\.\//.test(link) ||
      (link.startsWith("./") && link.includes("../")) ||
      link.includes("%5B"),
  ],

  head: [
    ["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
    [
      "meta",
      { property: "og:title", content: "Taskora — Task Queue for Node.js" },
    ],
    [
      "meta",
      {
        property: "og:description",
        content:
          "TypeScript-first distributed task queue. Batteries-included.",
      },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    [
      "meta",
      {
        name: "keywords",
        content:
          "task queue, job queue, node.js, typescript, redis, background jobs, distributed queue, BullMQ alternative, Agenda alternative, pg-boss alternative",
      },
    ],
  ],

  markdown: {
    codeTransformers: [transformerTwoslash()],
    config: (md) => {
      md.use(packageManagersMarkdownPlugin)
    },
  },

  vite: {
    plugins: [
      UnoCSS(),
      llms({
        domain: "https://taskora.dev",
        description:
          "Taskora — TypeScript-first distributed task queue for Node.js. Redis-backed, batteries-included.",
      }),
    ],
  },

  themeConfig: {
    logo: "/nav-logo.svg",

    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Features", link: "/features/retry-backoff" },
      { text: "Operations", link: "/operations/inspector" },
      { text: "Testing", link: "/testing/" },
      { text: "Recipes", link: "/recipes/email-queue" },
      { text: "API", link: "/api/" },
    ],

    sidebar: {
      ...typeDocSidebar,
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "Why Taskora", link: "/guide/" },
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Core Concepts", link: "/guide/core-concepts" },
          ],
        },
        {
          text: "Essentials",
          items: [
            { text: "Tasks", link: "/guide/tasks" },
            { text: "Dispatching Jobs", link: "/guide/dispatching" },
            { text: "Job Context", link: "/guide/job-context" },
            { text: "Adapters", link: "/guide/adapters" },
            { text: "Serializers", link: "/guide/serializers" },
            { text: "Error Handling", link: "/guide/error-handling" },
          ],
        },
      ],

      "/features/": [
        {
          text: "Reliability",
          items: [
            { text: "Retry & Backoff", link: "/features/retry-backoff" },
            { text: "TTL & Expiration", link: "/features/ttl-expiration" },
            { text: "Cancellation", link: "/features/cancellation" },
          ],
        },
        {
          text: "Composition",
          items: [
            { text: "Middleware", link: "/features/middleware" },
            { text: "Events", link: "/features/events" },
          ],
        },
        {
          text: "Flow Management",
          items: [
            { text: "Scheduling", link: "/features/scheduling" },
            { text: "Flow Control", link: "/features/flow-control" },
            {
              text: "Batch Processing",
              link: "/features/batch-processing",
            },
          ],
        },
        {
          text: "Evolution",
          items: [
            {
              text: "Versioning & Migrations",
              link: "/features/versioning",
            },
          ],
        },
      ],

      "/operations/": [
        {
          text: "Operations",
          items: [
            { text: "Inspector", link: "/operations/inspector" },
            {
              text: "Retention & DLQ",
              link: "/operations/dead-letter-queue",
            },
            { text: "Stall Detection", link: "/operations/stall-detection" },
            { text: "Monitoring", link: "/operations/monitoring" },
          ],
        },
      ],

      "/testing/": [
        {
          text: "Testing",
          items: [
            { text: "Overview", link: "/testing/" },
            { text: "run() vs execute()", link: "/testing/run-vs-execute" },
            { text: "Virtual Time", link: "/testing/virtual-time" },
            { text: "Patterns", link: "/testing/patterns" },
          ],
        },
      ],

      "/recipes/": [
        {
          text: "Recipes",
          items: [
            { text: "Email Queue", link: "/recipes/email-queue" },
            {
              text: "Image Processing",
              link: "/recipes/image-processing",
            },
            {
              text: "Webhook Delivery",
              link: "/recipes/webhook-delivery",
            },
            {
              text: "Rate-Limited API",
              link: "/recipes/rate-limited-api",
            },
            { text: "Cron Cleanup", link: "/recipes/cron-cleanup" },
          ],
        },
      ],
    },

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/kravetsone/taskora",
      },
      { icon: "npm", link: "https://www.npmjs.com/package/taskora" },
    ],

    editLink: {
      pattern:
        "https://github.com/kravetsone/taskora/edit/main/documentation/:path",
    },

    search: {
      provider: "local",
    },

    footer: {
      message: "Released under the MIT License.",
    },
  },
})
