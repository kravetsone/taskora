<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed } from "vue";

interface Job {
  id: number;
  color: string;
  progress: number;
  state: "queued" | "processing" | "done";
}

const colors = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#6366f1",
  "#ec4899",
  "#14b8a6",
];
let nextId = 1;

const queue = reactive<Job[]>([]);
const slots = reactive<(Job | null)[]>([null, null, null]);
const concurrency = ref(3);
const speed = ref(1);
const paused = ref(false);
const completedCount = ref(0);

let intervalId: ReturnType<typeof setInterval> | null = null;

function addJob() {
  queue.push({
    id: nextId++,
    color: colors[(nextId - 1) % colors.length],
    progress: 0,
    state: "queued",
  });
}

function addMany() {
  for (let i = 0; i < 10; i++) addJob();
}

function tick() {
  if (paused.value) return;

  // Fill empty slots from queue
  for (let i = 0; i < concurrency.value; i++) {
    if (!slots[i] && queue.length > 0) {
      const job = queue.shift()!;
      job.state = "processing";
      job.progress = 0;
      slots[i] = job;
    }
  }

  // Clear excess slots when concurrency decreases
  for (let i = concurrency.value; i < slots.length; i++) {
    if (slots[i]) {
      slots[i]!.state = "queued";
      queue.unshift(slots[i]!);
      slots[i] = null;
    }
  }

  // Progress active slots
  for (let i = 0; i < concurrency.value; i++) {
    const job = slots[i];
    if (job && job.state === "processing") {
      job.progress += 3 * speed.value;
      if (job.progress >= 100) {
        job.progress = 100;
        job.state = "done";
        completedCount.value++;
        slots[i] = null;
      }
    }
  }
}

onMounted(() => {
  intervalId = setInterval(tick, 50);
});
onUnmounted(() => {
  if (intervalId) clearInterval(intervalId);
});

// Ensure slots array matches max possible size
function ensureSlots() {
  while (slots.length < 10) slots.push(null);
}
ensureSlots();

const activeCount = computed(() => slots.filter((s) => s !== null).length);
</script>

<template>
  <div class="visualizer">
    <div class="visualizer-controls">
      <button class="visualizer-btn primary" @click="addJob">Add Job</button>
      <button class="visualizer-btn" @click="addMany">Add 10</button>
      <button class="visualizer-btn" :class="{ active: paused }" @click="paused = !paused">
        {{ paused ? "Resume" : "Pause" }}
      </button>
      <label class="visualizer-label">
        Workers: {{ concurrency }}
        <input type="range" v-model.number="concurrency" min="1" max="8" class="visualizer-slider" />
      </label>
      <label class="visualizer-label">
        Speed: {{ speed }}x
        <input type="range" v-model.number="speed" min="0.5" max="3" step="0.5" class="visualizer-slider" />
      </label>
    </div>

    <div class="worker-layout">
      <!-- Queue -->
      <div class="queue-column">
        <div class="column-header">
          Queue <span class="badge">{{ queue.length }}</span>
        </div>
        <div class="queue-list">
          <TransitionGroup name="queue-item">
            <div
              v-for="job in queue.slice(0, 12)"
              :key="job.id"
              class="queue-job"
              :style="{ '--job-color': job.color }"
            >
              <div class="job-block" :style="{ background: job.color }">
                #{{ job.id }}
              </div>
            </div>
          </TransitionGroup>
          <div v-if="queue.length > 12" class="queue-more">+{{ queue.length - 12 }} more</div>
        </div>
      </div>

      <!-- Arrow -->
      <div class="arrow-column">
        <svg width="40" height="40" viewBox="0 0 40 40">
          <path d="M8 20 L28 20 M22 14 L28 20 L22 26" stroke="var(--vp-c-text-3)" stroke-width="2" fill="none" stroke-linecap="round" />
        </svg>
      </div>

      <!-- Worker slots -->
      <div class="slots-column">
        <div class="column-header">
          Workers <span class="badge">{{ activeCount }}/{{ concurrency }}</span>
        </div>
        <div class="slots-grid">
          <div
            v-for="i in concurrency"
            :key="i"
            class="worker-slot"
            :class="{ active: slots[i - 1] }"
          >
            <template v-if="slots[i - 1]">
              <div class="slot-job" :style="{ '--job-color': slots[i - 1]!.color }">
                <svg class="progress-ring" width="44" height="44" viewBox="0 0 44 44">
                  <circle cx="22" cy="22" r="18" fill="none" stroke="var(--vp-c-border)" stroke-width="3" />
                  <circle
                    cx="22" cy="22" r="18" fill="none"
                    :stroke="slots[i - 1]!.color"
                    stroke-width="3"
                    stroke-linecap="round"
                    :stroke-dasharray="`${(slots[i - 1]!.progress / 100) * 113} 113`"
                    transform="rotate(-90 22 22)"
                  />
                </svg>
                <span class="slot-id">#{{ slots[i - 1]!.id }}</span>
              </div>
            </template>
            <template v-else>
              <span class="slot-empty">idle</span>
            </template>
          </div>
        </div>
      </div>

      <!-- Completed -->
      <div class="done-column">
        <div class="column-header">
          Done <span class="badge">{{ completedCount }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.worker-layout {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  min-height: 200px;
}

.column-header {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  margin-bottom: 0.5rem;
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  padding: 0 6px;
  height: 20px;
  border-radius: 10px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 0.75rem;
  font-weight: 600;
  margin-left: 0.25rem;
}

.queue-column {
  flex: 0 0 100px;
}

.queue-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.job-block {
  padding: 4px 10px;
  border-radius: 6px;
  color: #fff;
  font-size: 0.75rem;
  font-weight: 600;
  text-align: center;
}

.queue-more {
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  text-align: center;
  padding: 4px 0;
}

.queue-item-enter-active {
  transition: all 0.3s ease;
}
.queue-item-leave-active {
  transition: all 0.2s ease;
}
.queue-item-enter-from {
  opacity: 0;
  transform: translateY(-10px);
}
.queue-item-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

.arrow-column {
  display: flex;
  align-items: center;
  padding-top: 2rem;
}

.slots-column {
  flex: 1;
}

.slots-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.worker-slot {
  width: 64px;
  height: 64px;
  border-radius: 10px;
  border: 2px dashed var(--vp-c-border);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.worker-slot.active {
  border-style: solid;
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.slot-job {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.progress-ring {
  display: block;
}

.slot-id {
  position: absolute;
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.slot-empty {
  font-size: 0.6875rem;
  color: var(--vp-c-text-3);
}

.done-column {
  flex: 0 0 60px;
  text-align: center;
}
</style>
