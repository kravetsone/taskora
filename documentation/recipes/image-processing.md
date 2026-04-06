# Image Processing

Long-running image resize pipeline with progress tracking and heartbeat.

```ts
const processImage = app.task("process-image", {
  concurrency: 2,
  timeout: 120_000,
  retry: { attempts: 2, backoff: "fixed", delay: 5000 },
  handler: async (data: { url: string; sizes: number[] }, ctx) => {
    ctx.log.info("Starting image processing", { url: data.url })
    ctx.progress(0)

    // Download
    const buffer = await downloadImage(data.url, { signal: ctx.signal })
    ctx.progress(20)
    ctx.heartbeat() // extend lock for long job

    // Resize to each target size
    const results: { size: number; path: string }[] = []
    for (let i = 0; i < data.sizes.length; i++) {
      const size = data.sizes[i]
      const resized = await sharp(buffer)
        .resize(size, size, { fit: "cover" })
        .toBuffer()

      const path = await uploadToS3(`images/${ctx.id}/${size}.webp`, resized)
      results.push({ size, path })

      ctx.progress(20 + ((i + 1) / data.sizes.length) * 80)
      ctx.heartbeat()
    }

    ctx.log.info("Processing complete", { variants: results.length })
    return { variants: results }
  },
})

// Dispatch
const handle = processImage.dispatch({
  url: "https://example.com/photo.jpg",
  sizes: [64, 128, 256, 512, 1024],
})

// Track progress
const interval = setInterval(async () => {
  const progress = await handle.getProgress()
  console.log(`Progress: ${progress}%`)
  if (progress === 100) clearInterval(interval)
}, 1000)

const result = await handle.result
console.log("Variants:", result.variants)
```

Key patterns used:
- **`ctx.heartbeat()`** — prevents stall detection during long processing
- **`ctx.progress()`** — reports progress for UI feedback
- **`ctx.signal`** — cooperates with cancellation
- **`ctx.log`** — structured logging per job
