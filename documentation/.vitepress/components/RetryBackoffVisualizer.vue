<script setup lang="ts">
import { ref, computed, watch } from "vue"

const baseDelay = ref(1000)
const maxDelay = ref(60000)
const maxAttempts = ref(6)
const showJitter = ref(true)
const strategies = ref({
  fixed: true,
  exponential: true,
  linear: true,
})

const strategyColors = {
  fixed: "#3b82f6",
  exponential: "#ef4444",
  linear: "#22c55e",
}

const strategyLabels = {
  fixed: "Fixed",
  exponential: "Exponential",
  linear: "Linear",
}

function computeDelay(strategy: string, attempt: number): number {
  let delay: number
  switch (strategy) {
    case "fixed":
      delay = baseDelay.value
      break
    case "exponential":
      delay = baseDelay.value * Math.pow(2, attempt - 1)
      break
    case "linear":
      delay = baseDelay.value * attempt
      break
    default:
      delay = baseDelay.value
  }
  return Math.min(delay, maxDelay.value)
}

const chartData = computed(() => {
  const data: Record<string, { attempt: number; delay: number; jitterLow: number; jitterHigh: number }[]> = {}
  for (const [strategy, enabled] of Object.entries(strategies.value)) {
    if (!enabled) continue
    data[strategy] = []
    for (let a = 1; a <= maxAttempts.value; a++) {
      const delay = computeDelay(strategy, a)
      const jitter = delay * 0.25
      data[strategy].push({
        attempt: a,
        delay,
        jitterLow: Math.max(0, delay - jitter),
        jitterHigh: Math.min(maxDelay.value, delay + jitter),
      })
    }
  }
  return data
})

const svgWidth = 480
const svgHeight = 240
const padding = { top: 20, right: 20, bottom: 30, left: 55 }
const plotW = svgWidth - padding.left - padding.right
const plotH = svgHeight - padding.top - padding.bottom

const yMax = computed(() => {
  let max = 0
  for (const points of Object.values(chartData.value)) {
    for (const p of points) {
      max = Math.max(max, showJitter.value ? p.jitterHigh : p.delay)
    }
  }
  return Math.max(max * 1.1, 1000)
})

function xScale(attempt: number): number {
  return padding.left + ((attempt - 1) / Math.max(maxAttempts.value - 1, 1)) * plotW
}

function yScale(value: number): number {
  return padding.top + plotH - (value / yMax.value) * plotH
}

function formatDelay(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(0)}m`
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`
  return `${ms}ms`
}

const yTicks = computed(() => {
  const ticks: number[] = []
  const step = yMax.value / 4
  for (let i = 0; i <= 4; i++) {
    ticks.push(Math.round(step * i))
  }
  return ticks
})

const animKey = ref(0)
watch([baseDelay, maxDelay, maxAttempts, strategies, showJitter], () => {
  animKey.value++
})

const hoveredPoint = ref<{ strategy: string; attempt: number; delay: number; x: number; y: number } | null>(null)
</script>

<template>
  <div class="visualizer">
    <div class="visualizer-controls">
      <label class="visualizer-label">
        Base delay: {{ formatDelay(baseDelay) }}
        <input type="range" v-model.number="baseDelay" min="100" max="10000" step="100" class="visualizer-slider" />
      </label>
      <label class="visualizer-label">
        Max delay: {{ formatDelay(maxDelay) }}
        <input type="range" v-model.number="maxDelay" min="1000" max="120000" step="1000" class="visualizer-slider" />
      </label>
      <label class="visualizer-label">
        Attempts: {{ maxAttempts }}
        <input type="range" v-model.number="maxAttempts" min="2" max="15" class="visualizer-slider" />
      </label>
    </div>
    <div class="visualizer-controls" style="border-bottom: none; padding-bottom: 0; margin-bottom: 0">
      <label v-for="(enabled, strategy) in strategies" :key="strategy" class="strategy-toggle">
        <input type="checkbox" v-model="strategies[strategy]" />
        <span :style="{ color: strategyColors[strategy] }">{{ strategyLabels[strategy] }}</span>
      </label>
      <label class="strategy-toggle">
        <input type="checkbox" v-model="showJitter" />
        <span>Jitter band</span>
      </label>
    </div>

    <svg :viewBox="`0 0 ${svgWidth} ${svgHeight}`" class="backoff-svg" @mouseleave="hoveredPoint = null">
      <!-- Grid -->
      <line
        v-for="tick in yTicks" :key="tick"
        :x1="padding.left" :y1="yScale(tick)"
        :x2="svgWidth - padding.right" :y2="yScale(tick)"
        stroke="var(--vp-c-border)" stroke-width="0.5" stroke-dasharray="3 3"
      />

      <!-- Y axis labels -->
      <text
        v-for="tick in yTicks" :key="'label-' + tick"
        :x="padding.left - 8" :y="yScale(tick) + 3"
        text-anchor="end" class="axis-label"
      >
        {{ formatDelay(tick) }}
      </text>

      <!-- X axis labels -->
      <text
        v-for="a in maxAttempts" :key="'x-' + a"
        :x="xScale(a)" :y="svgHeight - 5"
        text-anchor="middle" class="axis-label"
      >
        {{ a }}
      </text>

      <!-- Max delay line -->
      <line
        :x1="padding.left" :y1="yScale(maxDelay)"
        :x2="svgWidth - padding.right" :y2="yScale(maxDelay)"
        stroke="#ef4444" stroke-width="1" stroke-dasharray="6 3" opacity="0.5"
      />
      <text :x="svgWidth - padding.right" :y="yScale(maxDelay) - 4" text-anchor="end" class="max-label">
        maxDelay
      </text>

      <!-- Strategy lines -->
      <g v-for="(points, strategy) in chartData" :key="strategy + '-' + animKey">
        <!-- Jitter band -->
        <polygon
          v-if="showJitter"
          :points="points.map((p, i) => `${xScale(p.attempt)},${yScale(p.jitterHigh)}`).join(' ') + ' ' + [...points].reverse().map((p) => `${xScale(p.attempt)},${yScale(p.jitterLow)}`).join(' ')"
          :fill="strategyColors[strategy]"
          opacity="0.08"
        />

        <!-- Line -->
        <polyline
          :points="points.map(p => `${xScale(p.attempt)},${yScale(p.delay)}`).join(' ')"
          fill="none"
          :stroke="strategyColors[strategy]"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="strategy-line"
        />

        <!-- Data points -->
        <circle
          v-for="p in points" :key="p.attempt"
          :cx="xScale(p.attempt)"
          :cy="yScale(p.delay)"
          r="4"
          :fill="strategyColors[strategy]"
          class="data-point"
          @mouseenter="hoveredPoint = { strategy: strategy as string, attempt: p.attempt, delay: p.delay, x: xScale(p.attempt), y: yScale(p.delay) }"
          @mouseleave="hoveredPoint = null"
        />
      </g>

      <!-- Tooltip -->
      <g v-if="hoveredPoint">
        <rect
          :x="hoveredPoint.x - 40" :y="hoveredPoint.y - 28"
          width="80" height="20" rx="4"
          fill="var(--vp-c-bg)" stroke="var(--vp-c-border)"
        />
        <text
          :x="hoveredPoint.x" :y="hoveredPoint.y - 15"
          text-anchor="middle" class="tooltip-text"
        >
          {{ formatDelay(hoveredPoint.delay) }}
        </text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.backoff-svg {
  width: 100%;
  max-width: 520px;
  margin: 1rem auto 0;
  display: block;
}

.axis-label {
  font-size: 9px;
  fill: var(--vp-c-text-3);
}

.max-label {
  font-size: 8px;
  fill: #ef4444;
  opacity: 0.7;
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

.strategy-line {
  animation: draw-line 1s ease-out forwards;
  stroke-dasharray: 1000;
  stroke-dashoffset: 1000;
}

@keyframes draw-line {
  to { stroke-dashoffset: 0; }
}

.data-point {
  cursor: pointer;
  transition: r 0.15s ease;
}

.data-point:hover {
  r: 6;
}

.tooltip-text {
  font-size: 10px;
  fill: var(--vp-c-text-1);
  font-weight: 600;
}
</style>
