# Email Queue

A complete email sending queue with validation, retry, and error handling.

```ts
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"
import { z } from "zod"

const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
})

const sendEmailTask = taskora.task("send-email", {
  input: z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(200),
    body: z.string(),
    replyTo: z.string().email().optional(),
  }),
  retry: {
    attempts: 3,
    backoff: "exponential",
    delay: 2000,
    noRetryOn: [ValidationError], // don't retry bad input
  },
  timeout: 15_000,
  handler: async (data, ctx) => {
    ctx.log.info("Sending email", { to: data.to, subject: data.subject })

    const result = await mailer.send({
      to: data.to,
      subject: data.subject,
      html: data.body,
      replyTo: data.replyTo,
    })

    return { messageId: result.id, accepted: result.accepted }
  },
})

// Usage
const handle = sendEmailTask.dispatch({
  to: "user@example.com",
  subject: "Welcome to our platform!",
  body: "<h1>Welcome!</h1><p>Thanks for signing up.</p>",
})

const result = await handle.result
console.log("Sent:", result.messageId)

// Monitor failures
sendEmailTask.on("failed", ({ id, error, willRetry }) => {
  if (!willRetry) {
    alertOncall(`Email permanently failed: ${error}`)
  }
})

await taskora.start()
```

## Testing

```ts
import { createTestRunner } from "taskora/test"

const runner = createTestRunner({ from: taskora })

it("sends email successfully", async () => {
  const result = await runner.execute(sendEmailTask, {
    to: "test@example.com",
    subject: "Test",
    body: "Hello",
  })
  expect(result.state).toBe("completed")
})

it("rejects invalid email", async () => {
  const result = await runner.execute(sendEmailTask, {
    to: "not-an-email",
    subject: "Test",
    body: "Hello",
  })
  expect(result.state).toBe("failed")
  expect(result.error).toContain("email")
})
```
