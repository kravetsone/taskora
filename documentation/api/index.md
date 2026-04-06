# API Reference

Complete type reference for all taskora exports.

## Entrypoints

### `taskora`

Core package — app factory, task class, types, utilities.

```ts
import {
  taskora,       // App factory
  App,           // App class
  Task,          // Task class
  ResultHandle,  // Dispatch result handle
  Inspector,     // Queue inspector
  DeadLetterManager, // DLQ manager
  compose,       // Middleware composition
  into,          // Type-safe migration helper
  json,          // Default JSON serializer
  parseDuration, // Duration string parser
  // Errors
  TaskoraError,
  ValidationError,
  RetryError,
  TimeoutError,
  JobFailedError,
  CancelledError,
  ThrottledError,
  DuplicateJobError,
  ExpiredError,
  StalledError,
} from "taskora"

// Types
import type { Taskora } from "taskora"
```

### `taskora/redis`

Redis adapter factory.

```ts
import { redisAdapter } from "taskora/redis"
```

### `taskora/memory`

In-memory adapter factory.

```ts
import { memoryAdapter } from "taskora/memory"
```

### `taskora/test`

Test runner utilities.

```ts
import { createTestRunner, TestRunner } from "taskora/test"
```

## Taskora Namespace

All public types live under the `Taskora` namespace:

```ts
import type { Taskora } from "taskora"

type Adapter = Taskora.Adapter
type Context = Taskora.Context
type MiddlewareContext = Taskora.MiddlewareContext
type Middleware = Taskora.Middleware
type JobState = Taskora.JobState
type RetryConfig = Taskora.RetryConfig
type BackoffStrategy = Taskora.BackoffStrategy
type DispatchOptions = Taskora.DispatchOptions
type Serializer = Taskora.Serializer
type LogEntry = Taskora.LogEntry
type JobInfo = Taskora.JobInfo
type QueueStats = Taskora.QueueStats
type ScheduleConfig = Taskora.ScheduleConfig
type Duration = Taskora.Duration
// ... and more
```

See `src/types.ts` for the complete namespace definition.
