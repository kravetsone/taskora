<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from "vue";

interface DispatchMark {
  id: number;
  time: number;
  accepted: boolean;
  label?: string;
}

const delay = ref(2000);
const throttleMax = ref(3);
const elapsedMs = ref(0);
let nextId = 1;
let rafId: number | null = null;
let lastTime: number | null = null;

// Debounce state
const debounceMarks = reactive<DispatchMark[]>([]);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const debounceEnqueued = ref<number>(0);

// Throttle state
const throttleMarks = reactive<DispatchMark[]>([]);
const throttleWindowStart = ref(0);
const throttleCount = ref(0);
const throttleEnqueued = ref<number>(0);

// Dedup state
const dedupMarks = reactive<DispatchMark[]>([]);
const dedupJobActive = ref(false);
let dedupJobTimer: ReturnType<typeof setTimeout> | null = null;
const dedupEnqueued = ref<number>(0);

function tick(now: number) {
  if (lastTime === null) lastTime = now;
  elapsedMs.value += now - lastTime;
  lastTime = now;
  rafId = requestAnimationFrame(tick);
}

onMounted(() => {
  rafId = requestAnimationFrame(tick);
});
onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  if (debounceTimer) clearTimeout(debounceTimer);
  if (dedupJobTimer) clearTimeout(dedupJobTimer);
});

function dispatch() {
  const time = elapsedMs.value;
  const id = nextId++;

  // Debounce
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceMarks.push({ id, time, accepted: true, label: "replaced" });
  debounceTimer = setTimeout(() => {
    debounceMarks[debounceMarks.length - 1].label = "ENQUEUED";
    debounceEnqueued.value++;
  }, delay.value);

  // Throttle
  if (time - throttleWindowStart.value > delay.value) {
    throttleWindowStart.value = time;
    throttleCount.value = 0;
  }
  const throttleAccepted = throttleCount.value < throttleMax.value;
  if (throttleAccepted) throttleCount.value++;
  throttleMarks.push({
    id,
    time,
    accepted: throttleAccepted,
    label: throttleAccepted ? "accepted" : "rejected",
  });
  if (throttleAccepted) throttleEnqueued.value++;

  // Dedup
  if (dedupJobActive.value) {
    dedupMarks.push({ id, time, accepted: false, label: "skipped" });
  } else {
    dedupMarks.push({ id, time, accepted: true, label: "created" });
    dedupJobActive.value = true;
    dedupEnqueued.value++;
    dedupJobTimer = setTimeout(() => {
      dedupJobActive.value = false;
    }, delay.value * 1.5);
  }
}

function rapidFire() {
  dispatch();
  for (let i = 1; i <= 4; i++) {
    setTimeout(() => dispatch(), i * 120);
  }
}

function reset() {
  debounceMarks.length = 0;
  throttleMarks.length = 0;
  dedupMarks.length = 0;
  debounceEnqueued.value = 0;
  throttleEnqueued.value = 0;
  dedupEnqueued.value = 0;
  throttleCount.value = 0;
  dedupJobActive.value = false;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (dedupJobTimer) {
    clearTimeout(dedupJobTimer);
    dedupJobTimer = null;
  }
}
</script>

<template>
  <div class="visualizer">
    <div class="visualizer-controls">
      <button class="visualizer-btn primary" @click="dispatch">Dispatch</button>
      <button class="visualizer-btn" @click="rapidFire">Rapid Fire (5x)</button>
      <button class="visualizer-btn" @click="reset">Reset</button>
      <label class="visualizer-label">
        Delay: {{ (delay / 1000).toFixed(1) }}s
        <input type="range" v-model.number="delay" min="500" max="5000" step="100" class="visualizer-slider" />
      </label>
      <label class="visualizer-label">
        Throttle max: {{ throttleMax }}
        <input type="range" v-model.number="throttleMax" min="1" max="8" class="visualizer-slider" />
      </label>
    </div>

    <div class="flow-columns">
      <!-- Debounce -->
      <div class="flow-col">
        <div class="flow-header">
          <span class="flow-title">Debounce</span>
          <span class="flow-badge">{{ debounceEnqueued }} enqueued</span>
        </div>
        <div class="flow-desc">Replaces previous — only last fires</div>
        <div class="flow-marks">
          <TransitionGroup name="mark">
            <div
              v-for="mark in debounceMarks.slice(-8)"
              :key="mark.id"
              class="mark"
              :class="{ accepted: mark.label === 'ENQUEUED', replaced: mark.label === 'replaced' }"
            >
              <span class="mark-dot" :class="mark.label === 'ENQUEUED' ? 'dot-green' : 'dot-gray'" />
              <span class="mark-text">#{{ mark.id }}</span>
              <span class="mark-label" :class="mark.label === 'ENQUEUED' ? 'label-green' : 'label-gray'">
                {{ mark.label }}
              </span>
            </div>
          </TransitionGroup>
        </div>
      </div>

      <!-- Throttle -->
      <div class="flow-col">
        <div class="flow-header">
          <span class="flow-title">Throttle</span>
          <span class="flow-badge">{{ throttleEnqueued }} enqueued</span>
        </div>
        <div class="flow-desc">{{ throttleCount }}/{{ throttleMax }} in window</div>
        <div class="flow-marks">
          <TransitionGroup name="mark">
            <div
              v-for="mark in throttleMarks.slice(-8)"
              :key="mark.id"
              class="mark"
              :class="{ accepted: mark.accepted, rejected: !mark.accepted }"
            >
              <span class="mark-dot" :class="mark.accepted ? 'dot-green' : 'dot-red'" />
              <span class="mark-text">#{{ mark.id }}</span>
              <span class="mark-label" :class="mark.accepted ? 'label-green' : 'label-red'">
                {{ mark.label }}
              </span>
            </div>
          </TransitionGroup>
        </div>
      </div>

      <!-- Dedup -->
      <div class="flow-col">
        <div class="flow-header">
          <span class="flow-title">Deduplicate</span>
          <span class="flow-badge">{{ dedupEnqueued }} enqueued</span>
        </div>
        <div class="flow-desc">
          Job {{ dedupJobActive ? "active" : "idle" }}
          <span v-if="dedupJobActive" class="active-dot" />
        </div>
        <div class="flow-marks">
          <TransitionGroup name="mark">
            <div
              v-for="mark in dedupMarks.slice(-8)"
              :key="mark.id"
              class="mark"
              :class="{ accepted: mark.accepted, rejected: !mark.accepted }"
            >
              <span class="mark-dot" :class="mark.accepted ? 'dot-green' : 'dot-red'" />
              <span class="mark-text">#{{ mark.id }}</span>
              <span class="mark-label" :class="mark.accepted ? 'label-green' : 'label-red'">
                {{ mark.label }}
              </span>
            </div>
          </TransitionGroup>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.flow-columns {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}

@media (max-width: 640px) {
  .flow-columns {
    grid-template-columns: 1fr;
  }
}

.flow-col {
  min-height: 180px;
}

.flow-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.25rem;
}

.flow-title {
  font-weight: 700;
  font-size: 0.875rem;
  color: var(--vp-c-text-1);
}

.flow-badge {
  font-size: 0.6875rem;
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg-soft);
  padding: 2px 8px;
  border-radius: 10px;
}

.flow-desc {
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.active-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  animation: pulse-soft 1s infinite;
}

.flow-marks {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mark {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-border);
  font-size: 0.75rem;
}

.mark.rejected {
  opacity: 0.5;
}

.mark-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-green { background: #22c55e; }
.dot-red { background: #ef4444; }
.dot-gray { background: #6b7280; }

.mark-text {
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.mark-label {
  margin-left: auto;
  font-size: 0.6875rem;
  font-weight: 500;
}

.label-green { color: #22c55e; }
.label-red { color: #ef4444; }
.label-gray { color: #6b7280; }

.mark-enter-active {
  transition: all 0.3s ease;
}
.mark-leave-active {
  transition: all 0.2s ease;
}
.mark-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.mark-leave-to {
  opacity: 0;
  transform: translateX(10px);
}
</style>
