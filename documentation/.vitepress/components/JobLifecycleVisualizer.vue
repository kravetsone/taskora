<script setup lang="ts">
import { ref, computed, onUnmounted } from "vue"

type State = "idle" | "waiting" | "active" | "completed" | "failed" | "retrying" | "delayed" | "cancelled" | "expired"

interface StateNode {
  id: State
  label: string
  x: number
  y: number
  color: string
}

const nodes: StateNode[] = [
  { id: "waiting",    label: "Waiting",    x: 100, y: 120, color: "#3b82f6" },
  { id: "delayed",    label: "Delayed",    x: 100, y: 30,  color: "#6366f1" },
  { id: "active",     label: "Active",     x: 280, y: 120, color: "#f59e0b" },
  { id: "completed",  label: "Completed",  x: 460, y: 40,  color: "#22c55e" },
  { id: "failed",     label: "Failed",     x: 460, y: 120, color: "#ef4444" },
  { id: "retrying",   label: "Retrying",   x: 460, y: 200, color: "#a855f7" },
  { id: "cancelled",  label: "Cancelled",  x: 280, y: 230, color: "#6b7280" },
  { id: "expired",    label: "Expired",    x: 100, y: 230, color: "#dc2626" },
]

interface Edge {
  from: State
  to: State
  label?: string
}

const edges: Edge[] = [
  { from: "waiting",  to: "active",    label: "dequeue" },
  { from: "delayed",  to: "waiting",   label: "due" },
  { from: "active",   to: "completed", label: "success" },
  { from: "active",   to: "failed",    label: "error" },
  { from: "active",   to: "retrying",  label: "retry" },
  { from: "retrying", to: "delayed",   label: "backoff" },
  { from: "active",   to: "cancelled", label: "cancel" },
  { from: "waiting",  to: "expired",   label: "ttl" },
]

const currentState = ref<State>("idle")
const attempt = ref(0)
const isAnimating = ref(false)
const pulseNode = ref<State | null>(null)
const outcome = ref<"completed" | "failed" | "retrying" | "cancelled" | "expired">("completed")

const dotPosition = computed(() => {
  if (currentState.value === "idle") return null
  const node = nodes.find((n) => n.id === currentState.value)
  return node ? { x: node.x, y: node.y } : null
})

let timer: ReturnType<typeof setTimeout> | null = null

function clearTimer() {
  if (timer) { clearTimeout(timer); timer = null }
}

onUnmounted(clearTimer)

async function dispatch() {
  if (isAnimating.value) return
  isAnimating.value = true
  attempt.value = 1

  await transitionTo("waiting")
  await wait(800)
  await transitionTo("active")
  await wait(1000)

  if (outcome.value === "completed") {
    await transitionTo("completed")
  } else if (outcome.value === "failed") {
    await transitionTo("failed")
  } else if (outcome.value === "cancelled") {
    await transitionTo("cancelled")
  } else if (outcome.value === "expired") {
    currentState.value = "waiting"
    await wait(600)
    await transitionTo("expired")
  } else if (outcome.value === "retrying") {
    await transitionTo("retrying")
    await wait(600)
    await transitionTo("delayed")
    await wait(600)
    attempt.value = 2
    await transitionTo("waiting")
    await wait(600)
    await transitionTo("active")
    await wait(800)
    await transitionTo("completed")
  }

  isAnimating.value = false
}

function transitionTo(state: State): Promise<void> {
  return new Promise((resolve) => {
    currentState.value = state
    pulseNode.value = state
    timer = setTimeout(() => {
      pulseNode.value = null
      resolve()
    }, 500)
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
  })
}

function reset() {
  clearTimer()
  currentState.value = "idle"
  attempt.value = 0
  isAnimating.value = false
  pulseNode.value = null
}

function getNode(id: State) {
  return nodes.find((n) => n.id === id)!
}
</script>

<template>
  <div class="visualizer">
    <div class="visualizer-controls">
      <button class="visualizer-btn primary" :disabled="isAnimating" @click="dispatch">
        Dispatch Job
      </button>
      <label class="visualizer-label">
        Outcome
        <select v-model="outcome" class="visualizer-select" :disabled="isAnimating">
          <option value="completed">Complete</option>
          <option value="failed">Fail</option>
          <option value="retrying">Retry then Complete</option>
          <option value="cancelled">Cancel</option>
          <option value="expired">Expire</option>
        </select>
      </label>
      <button v-if="currentState !== 'idle'" class="visualizer-btn" @click="reset">Reset</button>
    </div>

    <svg viewBox="0 0 560 270" class="lifecycle-svg">
      <!-- Edges -->
      <g v-for="edge in edges" :key="`${edge.from}-${edge.to}`">
        <line
          :x1="getNode(edge.from).x"
          :y1="getNode(edge.from).y"
          :x2="getNode(edge.to).x"
          :y2="getNode(edge.to).y"
          stroke="var(--vp-c-border)"
          stroke-width="1.5"
          stroke-dasharray="4 3"
        />
        <text
          :x="(getNode(edge.from).x + getNode(edge.to).x) / 2"
          :y="(getNode(edge.from).y + getNode(edge.to).y) / 2 - 6"
          text-anchor="middle"
          class="edge-label"
        >
          {{ edge.label }}
        </text>
      </g>

      <!-- Nodes -->
      <g v-for="node in nodes" :key="node.id">
        <circle
          :cx="node.x"
          :cy="node.y"
          r="26"
          :fill="node.color + '18'"
          :stroke="node.color"
          stroke-width="2"
          :class="{ 'node-pulse': pulseNode === node.id }"
        />
        <text
          :x="node.x"
          :y="node.y + 4"
          text-anchor="middle"
          class="node-label"
          :fill="node.color"
        >
          {{ node.label }}
        </text>
      </g>

      <!-- Job dot -->
      <g v-if="dotPosition" class="job-dot-group">
        <circle
          :cx="dotPosition.x"
          :cy="dotPosition.y"
          r="8"
          fill="var(--vp-c-brand-1)"
          class="job-dot"
        />
        <text
          v-if="attempt > 0"
          :x="dotPosition.x"
          :y="dotPosition.y + 3.5"
          text-anchor="middle"
          fill="#fff"
          font-size="8"
          font-weight="bold"
        >
          {{ attempt }}
        </text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.lifecycle-svg {
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  display: block;
}

.node-label {
  font-size: 10px;
  font-weight: 600;
  pointer-events: none;
}

.edge-label {
  font-size: 8px;
  fill: var(--vp-c-text-3);
  pointer-events: none;
}

.node-pulse {
  animation: node-pulse-anim 0.5s ease-out;
}

@keyframes node-pulse-anim {
  0% { transform-origin: center; r: 26; }
  50% { r: 32; }
  100% { r: 26; }
}

.job-dot {
  filter: drop-shadow(0 0 6px var(--vp-c-brand-1));
  transition: cx 0.4s ease-in-out, cy 0.4s ease-in-out;
}

.job-dot-group {
  transition: all 0.4s ease-in-out;
}
</style>
