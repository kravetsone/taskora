<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed } from "vue"

const colors = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#6366f1", "#ec4899", "#14b8a6"]
let nextId = 1

interface Item {
  id: number
  color: string
}

interface Batch {
  id: number
  items: Item[]
  trigger: "delay" | "maxSize" | "maxWait"
}

const buffer = reactive<Item[]>([])
const batches = reactive<Batch[]>([])
let batchId = 0

const delayMs = ref(2000)
const maxSize = ref(5)
const maxWaitMs = ref(8000)
const streaming = ref(false)

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
let streamTimer: ReturnType<typeof setInterval> | null = null
const debounceProgress = ref(0)
const maxWaitProgress = ref(0)
let debounceStart = 0
let maxWaitStart = 0
let rafId: number | null = null

function tick(now: number) {
  if (debounceTimer && debounceStart) {
    debounceProgress.value = Math.min(1, (Date.now() - debounceStart) / delayMs.value)
  }
  if (maxWaitTimer && maxWaitStart) {
    maxWaitProgress.value = Math.min(1, (Date.now() - maxWaitStart) / maxWaitMs.value)
  }
  rafId = requestAnimationFrame(tick)
}

onMounted(() => {
  rafId = requestAnimationFrame(tick)
})
onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId)
  clearTimers()
  if (streamTimer) clearInterval(streamTimer)
})

function clearTimers() {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
  if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null }
  debounceProgress.value = 0
  maxWaitProgress.value = 0
  debounceStart = 0
  maxWaitStart = 0
}

function flush(trigger: "delay" | "maxSize" | "maxWait") {
  if (buffer.length === 0) return
  batches.unshift({ id: batchId++, items: [...buffer], trigger })
  buffer.length = 0
  clearTimers()
  if (batches.length > 5) batches.length = 5
}

function addItem() {
  const item: Item = {
    id: nextId++,
    color: colors[(nextId - 1) % colors.length],
  }
  buffer.push(item)

  // Check maxSize
  if (buffer.length >= maxSize.value) {
    flush("maxSize")
    return
  }

  // Reset debounce timer
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceStart = Date.now()
  debounceProgress.value = 0
  debounceTimer = setTimeout(() => flush("delay"), delayMs.value)

  // Start maxWait timer (only on first item after flush)
  if (!maxWaitTimer && maxWaitMs.value > 0) {
    maxWaitStart = Date.now()
    maxWaitProgress.value = 0
    maxWaitTimer = setTimeout(() => flush("maxWait"), maxWaitMs.value)
  }
}

function toggleStream() {
  streaming.value = !streaming.value
  if (streaming.value) {
    streamTimer = setInterval(() => {
      addItem()
    }, 300 + Math.random() * 700)
  } else {
    if (streamTimer) { clearInterval(streamTimer); streamTimer = null }
  }
}

function reset() {
  buffer.length = 0
  batches.length = 0
  clearTimers()
  streaming.value = false
  if (streamTimer) { clearInterval(streamTimer); streamTimer = null }
}

const sizeProgress = computed(() => buffer.length / maxSize.value)

const triggerColors = { delay: "#3b82f6", maxSize: "#f59e0b", maxWait: "#ef4444" }
const triggerLabels = { delay: "debounce", maxSize: "maxSize", maxWait: "maxWait" }
</script>

<template>
  <div class="visualizer">
    <div class="visualizer-controls">
      <button class="visualizer-btn primary" @click="addItem">Add Item</button>
      <button class="visualizer-btn" :class="{ active: streaming }" @click="toggleStream">
        {{ streaming ? "Stop Stream" : "Stream Items" }}
      </button>
      <button class="visualizer-btn" @click="reset">Reset</button>
      <label class="visualizer-label">
        Delay: {{ (delayMs / 1000).toFixed(1) }}s
        <input type="range" v-model.number="delayMs" min="500" max="5000" step="100" class="visualizer-slider" />
      </label>
      <label class="visualizer-label">
        Max size: {{ maxSize }}
        <input type="range" v-model.number="maxSize" min="2" max="20" class="visualizer-slider" />
      </label>
      <label class="visualizer-label">
        Max wait: {{ (maxWaitMs / 1000).toFixed(0) }}s
        <input type="range" v-model.number="maxWaitMs" min="2000" max="15000" step="1000" class="visualizer-slider" />
      </label>
    </div>

    <div class="collect-layout">
      <!-- Buffer bucket -->
      <div class="bucket-area">
        <div class="bucket-label">Buffer <span class="badge">{{ buffer.length }}/{{ maxSize }}</span></div>
        <div class="bucket">
          <TransitionGroup name="item">
            <div
              v-for="item in buffer"
              :key="item.id"
              class="bucket-item"
              :style="{ background: item.color }"
            >
              {{ item.id }}
            </div>
          </TransitionGroup>
        </div>

        <!-- Gauges -->
        <div class="gauges">
          <div class="gauge">
            <div class="gauge-label" style="color: #3b82f6">Debounce</div>
            <div class="gauge-bar">
              <div class="gauge-fill" :style="{ width: `${debounceProgress * 100}%`, background: '#3b82f6' }" />
            </div>
          </div>
          <div class="gauge">
            <div class="gauge-label" style="color: #f59e0b">Size</div>
            <div class="gauge-bar">
              <div class="gauge-fill" :style="{ width: `${sizeProgress * 100}%`, background: '#f59e0b' }" />
            </div>
          </div>
          <div class="gauge">
            <div class="gauge-label" style="color: #ef4444">Max wait</div>
            <div class="gauge-bar">
              <div class="gauge-fill" :style="{ width: `${maxWaitProgress * 100}%`, background: '#ef4444' }" />
            </div>
          </div>
        </div>
      </div>

      <!-- Arrow -->
      <div class="arrow-sep">
        <svg width="32" height="32" viewBox="0 0 32 32">
          <path d="M6 16 L22 16 M17 10 L23 16 L17 22" stroke="var(--vp-c-text-3)" stroke-width="2" fill="none" stroke-linecap="round" />
        </svg>
      </div>

      <!-- Batches -->
      <div class="batches-area">
        <div class="bucket-label">Flushed Batches</div>
        <TransitionGroup name="batch" tag="div" class="batches-list">
          <div v-for="batch in batches" :key="batch.id" class="batch-card">
            <div class="batch-header">
              <span>Batch #{{ batch.id + 1 }}</span>
              <span class="batch-trigger" :style="{ color: triggerColors[batch.trigger] }">
                {{ triggerLabels[batch.trigger] }}
              </span>
            </div>
            <div class="batch-items">
              <span
                v-for="item in batch.items"
                :key="item.id"
                class="batch-dot"
                :style="{ background: item.color }"
              />
              <span class="batch-count">{{ batch.items.length }} items</span>
            </div>
          </div>
        </TransitionGroup>
      </div>
    </div>
  </div>
</template>

<style scoped>
.collect-layout {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.bucket-area {
  flex: 0 0 180px;
}

.bucket-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  margin-bottom: 0.5rem;
}

.badge {
  font-size: 0.6875rem;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  padding: 1px 6px;
  border-radius: 8px;
  margin-left: 4px;
}

.bucket {
  min-height: 120px;
  border: 2px dashed var(--vp-c-border);
  border-radius: 10px;
  padding: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-content: flex-end;
}

.bucket-item {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 0.625rem;
  font-weight: 700;
}

.item-enter-active { transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.item-leave-active { transition: all 0.2s ease; }
.item-enter-from { opacity: 0; transform: translateY(-12px) scale(0.8); }
.item-leave-to { opacity: 0; transform: scale(0.5); }

.gauges {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 0.5rem;
}

.gauge {
  display: flex;
  align-items: center;
  gap: 6px;
}

.gauge-label {
  font-size: 0.625rem;
  font-weight: 600;
  width: 56px;
  text-align: right;
}

.gauge-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--vp-c-border);
  overflow: hidden;
}

.gauge-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.1s linear;
}

.arrow-sep {
  display: flex;
  align-items: center;
  padding-top: 3rem;
}

.batches-area {
  flex: 1;
  min-width: 180px;
}

.batches-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.batch-card {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-border);
  background: var(--vp-c-bg);
}

.batch-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 4px;
}

.batch-trigger {
  font-size: 0.6875rem;
  font-weight: 700;
}

.batch-items {
  display: flex;
  align-items: center;
  gap: 3px;
}

.batch-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.batch-count {
  margin-left: 6px;
  font-size: 0.6875rem;
  color: var(--vp-c-text-3);
}

.batch-enter-active { transition: all 0.3s ease; }
.batch-leave-active { transition: all 0.2s ease; }
.batch-enter-from { opacity: 0; transform: translateX(-10px); }
.batch-leave-to { opacity: 0; }
</style>
