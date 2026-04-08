import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import TwoslashFloatingVue from "@shikijs/vitepress-twoslash/client";
import "@shikijs/vitepress-twoslash/style.css";
import "virtual:uno.css";
import "virtual:group-icons.css";
import "./style.css";
import { enhanceAppWithPackageManagers } from "vitepress-plugin-package-managers/client";
import { icons } from "vitepress-plugin-package-managers/icons";

import Layout from "./Layout.vue";
import HeroBadges from "../components/HeroBadges.vue";
import JobLifecycleVisualizer from "../components/JobLifecycleVisualizer.vue";
import RetryBackoffVisualizer from "../components/RetryBackoffVisualizer.vue";
import WorkerConcurrencyVisualizer from "../components/WorkerConcurrencyVisualizer.vue";
import MiddlewarePipelineVisualizer from "../components/MiddlewarePipelineVisualizer.vue";
import FlowControlVisualizer from "../components/FlowControlVisualizer.vue";
import CollectBatchVisualizer from "../components/CollectBatchVisualizer.vue";
import SchedulerVisualizer from "../components/SchedulerVisualizer.vue";
import TestingMatrix from "../components/TestingMatrix.vue";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.use(TwoslashFloatingVue);
    enhanceAppWithPackageManagers(app, { icons });
    app.component("HeroBadges", HeroBadges);
    app.component("JobLifecycleVisualizer", JobLifecycleVisualizer);
    app.component("RetryBackoffVisualizer", RetryBackoffVisualizer);
    app.component("WorkerConcurrencyVisualizer", WorkerConcurrencyVisualizer);
    app.component("MiddlewarePipelineVisualizer", MiddlewarePipelineVisualizer);
    app.component("FlowControlVisualizer", FlowControlVisualizer);
    app.component("CollectBatchVisualizer", CollectBatchVisualizer);
    app.component("SchedulerVisualizer", SchedulerVisualizer);
    app.component("TestingMatrix", TestingMatrix);
  },
} satisfies Theme;
