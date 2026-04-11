# Observability

Taskora exposes three operational surfaces beyond the dispatch/handler path:

- **Inspector** — cross-task queries, queue stats, per-job details
- **DeadLetterManager** — list failed jobs, retry individually or in bulk
- **Schedules** — runtime list/pause/resume/trigger/delete for scheduled tasks

`@taskora/nestjs` exposes each one as a regular Nest provider. The default slot resolves via the **class token**, so you can write `constructor(private inspector: Inspector)` without any decorator — just like constructor-injecting `DataSource` from TypeORM. For named multi-app slots, use `@InjectInspector('name')`, `@InjectDeadLetters('name')`, or `@InjectSchedules('name')`.

## Inspector

The `Inspector` is taskora's read-heavy query surface — cross-task search by job ID, per-state queue listings, aggregated stats, migration distribution, and per-job details with logs/progress/timeline.

```ts
import { Injectable } from "@nestjs/common"
import { Inspector } from "taskora"

@Injectable()
export class QueueStatsService {
  constructor(private readonly inspector: Inspector) {}

  async dashboardSnapshot() {
    const stats = await this.inspector.stats()
    const recentlyFailed = await this.inspector.failed({ limit: 20 })
    const activeWorkflows = (await this.inspector.active()).length
    return { stats, recentlyFailed, activeWorkflows }
  }

  async findJob(jobId: string) {
    return this.inspector.find(jobId)
  }
}
```

### Typical uses

- **Admin HTTP endpoints** — expose `inspector.stats()` / `inspector.failed()` / `inspector.find()` behind your own auth if you don't want to mount the full board.
- **Health checks** — assert queue depth is under a threshold, or that there are no stalled jobs.
- **Business dashboards** — build custom panels that show per-task completion rates, recent activity, or cross-task drilldowns.

### Controller example

```ts
import { Controller, Get, Param, UseGuards } from "@nestjs/common"
import { Inspector } from "taskora"
import { AdminGuard } from "../auth/admin.guard"

@Controller("admin/queue")
@UseGuards(AdminGuard)
export class QueueAdminController {
  constructor(private readonly inspector: Inspector) {}

  @Get("stats")
  stats() {
    return this.inspector.stats()
  }

  @Get("failed")
  failed() {
    return this.inspector.failed({ limit: 100 })
  }

  @Get("jobs/:id")
  async findJob(@Param("id") id: string) {
    const job = await this.inspector.find(id)
    if (!job) return { found: false }
    return { found: true, job }
  }
}
```

See the main [Inspector](/operations/inspector) guide for the full method list.

## Dead Letter Manager

`DeadLetterManager` is the admin-side handle for permanently-failed jobs. It's a view over taskora's `:failed` sorted set — list, retry one, retry all.

```ts
import { Injectable } from "@nestjs/common"
import { DeadLetterManager } from "taskora"

@Injectable()
export class DlqService {
  constructor(private readonly dlq: DeadLetterManager) {}

  async recent(limit = 50) {
    return this.dlq.list({ limit })
  }

  async recentForTask(taskName: string, limit = 50) {
    return this.dlq.list({ task: taskName, limit })
  }

  async retryOne(jobId: string) {
    return this.dlq.retry(jobId)
  }

  async retryAllForTask(taskName: string) {
    return this.dlq.retryAll({ task: taskName })
  }
}
```

### Retrying a specific job

```ts
@Controller("admin/dlq")
@UseGuards(AdminGuard)
export class DlqController {
  constructor(private readonly dlq: DeadLetterManager) {}

  @Post("jobs/:id/retry")
  retry(@Param("id") id: string) {
    return this.dlq.retry(id)
  }
}
```

`retry(jobId)` searches across every task for the job, so you don't need to know which task it belongs to. For the typed variant that keeps `JobInfo<TInput, TOutput>` generics, pass the `Task` object: `dlq.retry(task, jobId)`.

### Bulk retry

`retryAll({ task? })` retries every job in the DLQ for the given task (or all tasks if omitted). The underlying Lua script batches 100 jobs per iteration so it's safe to run against thousands of entries.

## Schedules

`app.schedules` is the runtime manager for scheduled tasks — list current schedules, pause/resume specific ones, trigger a run manually, update the cron or interval, delete a schedule entirely.

The `ScheduleManager` class isn't in taskora's public type exports, so `@InjectSchedules` uses a string token and the type annotation references `App["schedules"]`:

```ts
import { Injectable } from "@nestjs/common"
import { InjectSchedules } from "@taskora/nestjs"
import type { App } from "taskora"

@Injectable()
export class SchedulesService {
  constructor(@InjectSchedules() private readonly schedules: App["schedules"]) {}

  async listAll() {
    return this.schedules.list()
  }

  async pause(name: string) {
    return this.schedules.pause(name)
  }

  async resume(name: string) {
    return this.schedules.resume(name)
  }

  async triggerNow(name: string) {
    return this.schedules.trigger(name)
  }

  async remove(name: string) {
    return this.schedules.remove(name)
  }

  async updateInterval(name: string, every: string) {
    return this.schedules.update(name, { every })
  }
}
```

### Registering schedules dynamically

If your schedules come from a database or config service (rather than being hard-coded in `defineTask`), register them from an `OnModuleInit` provider:

```ts
import { Injectable, OnModuleInit } from "@nestjs/common"
import { InjectApp, InjectSchedules } from "@taskora/nestjs"
import type { App } from "taskora"
import { ConfigService } from "@nestjs/config"

@Injectable()
export class ScheduleRegistrar implements OnModuleInit {
  constructor(
    @InjectApp() private readonly app: App,
    @InjectSchedules() private readonly schedules: App["schedules"],
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    for (const job of this.config.get<ScheduledJob[]>("scheduledJobs", [])) {
      this.app.schedule(job.name, { cron: job.cron, task: job.taskName, data: job.payload })
    }
  }
}
```

`app.schedule()` stages the schedule for when the App starts; the `TaskoraExplorer` calls `app.start()` during `onApplicationBootstrap`, which flushes all pending schedules into the scheduler. Registering schedules in `onModuleInit` (before bootstrap) is the right lifecycle hook.

## Multi-app observability

Each named app gets its own Inspector / DLQ / Schedules slot:

```ts
import { Injectable } from "@nestjs/common"
import {
  InjectDeadLetters,
  InjectInspector,
  InjectSchedules,
} from "@taskora/nestjs"
import { DeadLetterManager, Inspector } from "taskora"
import type { App } from "taskora"

@Injectable()
export class AdminService {
  constructor(
    // Default app — zero-decorator class tokens
    readonly primaryInspector: Inspector,
    readonly primaryDlq: DeadLetterManager,
    @InjectSchedules() readonly primarySchedules: App["schedules"],

    // Named "secondary" app — string tokens via decorators
    @InjectInspector("secondary") readonly secondaryInspector: Inspector,
    @InjectDeadLetters("secondary") readonly secondaryDlq: DeadLetterManager,
    @InjectSchedules("secondary") readonly secondarySchedules: App["schedules"],
  ) {}
}
```

The default slot uses the `Inspector` / `DeadLetterManager` class tokens (only one `forRoot` without a `name` can own those). Every named slot goes through the string-token decorators. Schedules always use the decorator since `App["schedules"]` isn't a class.

## Full admin module pattern

A clean way to package observability endpoints is one module, one controller per surface:

```
src/admin/
├── admin.module.ts
├── admin.guard.ts
├── queue.controller.ts    ← uses Inspector
├── dlq.controller.ts      ← uses DeadLetterManager
└── schedules.controller.ts ← uses App['schedules']
```

```ts
@Module({
  providers: [AdminGuard],
  controllers: [QueueController, DlqController, SchedulesController],
})
export class AdminModule {}
```

`TaskoraModule` in `AppModule` is `@Global`, so `AdminModule` doesn't need to re-import it — `Inspector` / `DeadLetterManager` / schedules are already in scope.

For a ready-made UI instead of a custom admin module, reach for [`@taskora/board`](./board).
