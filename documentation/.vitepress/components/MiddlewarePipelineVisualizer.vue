<script setup lang="ts">
import { ref, computed } from "vue"

type Phase = "idle" | "entering" | "app-mw-1-in" | "app-mw-2-in" | "task-mw-in" | "handler" | "task-mw-out" | "app-mw-2-out" | "app-mw-1-out" | "done"

const layers = [
  { id: "app-mw-1", label: "App MW 1", color: "#3b82f6", inPhase: "app-mw-1-in" as Phase, outPhase: "app-mw-1-out" as Phase },
  { id: "app-mw-2", label: "App MW 2", color: "#6366f1", inPhase: "app-mw-2-in" as Phase, outPhase: "app-mw-2-out" as Phase },
  { id: "task-mw", label: "Task MW", color: "#a855f7", inPhase: "task-mw-in" as Phase, outPhase: "task-mw-out" as Phase },
]

const phase = ref<Phase>("idle")
const isRunning = ref(false)
const dataSnippet = ref('{ to: "user@..." }')
const resultSnippet = ref("")
const showMutate = ref(false)

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runRequest() {
  if (isRunning.value) return
  isRunning.value = true
  dataSnippet.value = '{ to: "user@..." }'
  resultSnippet.value = ""

  phase.value = "entering"
  await wait(400)

  // Inward journey
  phase.value = "app-mw-1-in"
  if (showMutate.value) dataSnippet.value = '{ to: "user@...", ts: 1712... }'
  await wait(500)

  phase.value = "app-mw-2-in"
  await wait(500)

  phase.value = "task-mw-in"
  await wait(500)

  // Handler
  phase.value = "handler"
  await wait(700)
  resultSnippet.value = '{ messageId: "abc" }'

  // Outward journey
  phase.value = "task-mw-out"
  await wait(500)

  phase.value = "app-mw-2-out"
  await wait(500)

  phase.value = "app-mw-1-out"
  if (showMutate.value) resultSnippet.value = '{ data: {...}, meta: {...} }'
  await wait(500)

  phase.value = "done"
  await wait(600)
  phase.value = "idle"
  isRunning.value = false
}

function isLayerActive(layer: typeof layers[0]): boolean {
  return phase.value === layer.inPhase || phase.value === layer.outPhase
}

function isInward(layer: typeof layers[0]): boolean {
  return phase.value === layer.inPhase
}

const handlerActive = computed(() => phase.value === "handler")

const currentDirection = computed(() => {
  const inPhases: Phase[] = ["entering", "app-mw-1-in", "app-mw-2-in", "task-mw-in"]
  if (inPhases.includes(phase.value)) return "in"
  return "out"
})
</script>

<template>
  <div class="visualizer">
    <div class="visualizer-controls">
      <button class="visualizer-btn primary" :disabled="isRunning" @click="runRequest">
        Run Request
      </button>
      <label class="strategy-toggle">
        <input type="checkbox" v-model="showMutate" :disabled="isRunning" />
        <span>Mutate data/result</span>
      </label>
      <span v-if="phase !== 'idle'" class="phase-indicator">
        {{ currentDirection === "in" ? "before next()" : "after next()" }}
      </span>
    </div>

    <div class="pipeline-layout">
      <!-- Onion layers -->
      <div class="onion">
        <div
          v-for="(layer, i) in layers"
          :key="layer.id"
          class="onion-layer"
          :class="{ active: isLayerActive(layer), inward: isInward(layer) }"
          :style="{
            '--layer-color': layer.color,
            '--layer-size': `${220 - i * 50}px`,
            '--layer-height': `${160 - i * 36}px`,
          }"
        >
          <span class="layer-label" :style="{ color: layer.color }">{{ layer.label }}</span>
        </div>

        <!-- Handler center -->
        <div class="handler-core" :class="{ active: handlerActive }">
          Handler
        </div>
      </div>

      <!-- Data flow display -->
      <div class="data-flow">
        <div v-if="dataSnippet && phase !== 'idle'" class="data-box">
          <span class="data-label">ctx.data</span>
          <code>{{ dataSnippet }}</code>
        </div>
        <div v-if="resultSnippet" class="data-box result">
          <span class="data-label">ctx.result</span>
          <code>{{ resultSnippet }}</code>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pipeline-layout {
  display: flex;
  gap: 1.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.onion {
  position: relative;
  width: 240px;
  height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.onion-layer {
  position: absolute;
  width: var(--layer-size);
  height: var(--layer-height);
  border: 2px solid var(--layer-color);
  border-radius: 12px;
  opacity: 0.3;
  transition: all 0.3s ease;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 4px;
}

.onion-layer.active {
  opacity: 1;
  border-width: 3px;
  box-shadow: 0 0 16px color-mix(in srgb, var(--layer-color) 30%, transparent);
}

.onion-layer.active.inward {
  background: color-mix(in srgb, var(--layer-color) 6%, transparent);
}

.layer-label {
  font-size: 0.6875rem;
  font-weight: 600;
  opacity: 0.8;
}

.handler-core {
  width: 70px;
  height: 52px;
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  border: 2px solid var(--vp-c-border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--vp-c-text-2);
  transition: all 0.3s ease;
  z-index: 1;
}

.handler-core.active {
  background: #22c55e18;
  border-color: #22c55e;
  color: #22c55e;
  box-shadow: 0 0 20px rgba(34, 197, 94, 0.25);
}

.data-flow {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  flex: 1;
  min-width: 180px;
}

.data-box {
  padding: 0.625rem 0.875rem;
  border-radius: 8px;
  border: 1px solid var(--vp-c-border);
  background: var(--vp-c-bg);
  animation: slide-in-up 0.3s ease;
}

.data-box.result {
  border-color: #22c55e40;
  background: #22c55e08;
}

.data-label {
  display: block;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--vp-c-text-3);
  margin-bottom: 0.25rem;
}

.data-box code {
  font-size: 0.75rem;
  color: var(--vp-c-text-1);
}

.phase-indicator {
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  font-style: italic;
}

.strategy-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}

.strategy-toggle input {
  accent-color: var(--vp-c-brand-1);
}
</style>
