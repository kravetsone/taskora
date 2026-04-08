<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed } from "vue";

interface Instance {
  id: number;
  state: "follower" | "leader" | "dead";
}

interface Tick {
  id: number;
  time: number;
  dispatched: boolean;
  skipped: boolean;
  reason?: string;
}

const instances = reactive<Instance[]>([
  { id: 1, state: "leader" },
  { id: 2, state: "follower" },
  { id: 3, state: "follower" },
]);

const ticks = reactive<Tick[]>([]);
let tickId = 0;
const overlap = ref(false);
const missedPolicy = ref<"skip" | "catch-up" | "catch-up-limit:3">("skip");
const paused = ref(false);
const jobActive = ref(false);
const intervalMs = 2000;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let jobTimer: ReturnType<typeof setTimeout> | null = null;

const leader = computed(() => instances.find((i) => i.state === "leader"));

function schedulerTick() {
  if (paused.value) return;

  const canDispatch = overlap.value || !jobActive.value;
  const tick: Tick = {
    id: tickId++,
    time: Date.now(),
    dispatched: canDispatch,
    skipped: !canDispatch,
    reason: !canDispatch ? "overlap" : undefined,
  };
  ticks.push(tick);
  if (ticks.length > 12) ticks.shift();

  if (canDispatch) {
    jobActive.value = true;
    jobTimer = setTimeout(() => {
      jobActive.value = false;
    }, intervalMs * 1.5);
  }
}

onMounted(() => {
  tickTimer = setInterval(schedulerTick, intervalMs);
});
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
  if (jobTimer) clearTimeout(jobTimer);
});

function killLeader() {
  const currentLeader = instances.find((i) => i.state === "leader");
  if (!currentLeader) return;

  currentLeader.state = "dead";

  // Failover after a short delay
  setTimeout(() => {
    const follower = instances.find((i) => i.state === "follower");
    if (follower) follower.state = "leader";
  }, 800);
}

function reviveInstance(inst: Instance) {
  if (inst.state === "dead") {
    inst.state = "follower";
  }
}

function addInstance() {
  instances.push({
    id: instances.length + 1,
    state: "follower",
  });
}

function removeInstance() {
  if (instances.length <= 1) return;
  const removed = instances.pop();
  if (removed?.state === "leader") {
    const first = instances.find((i) => i.state === "follower");
    if (first) first.state = "leader";
  }
}

function togglePause() {
  paused.value = !paused.value;
  if (!paused.value && missedPolicy.value !== "skip") {
    // Simulate catch-up on resume
    const catchUpCount =
      missedPolicy.value === "catch-up"
        ? 5
        : missedPolicy.value.startsWith("catch-up-limit:")
          ? 3
          : 0;

    for (let i = 0; i < catchUpCount; i++) {
      setTimeout(() => {
        ticks.push({
          id: tickId++,
          time: Date.now(),
          dispatched: true,
          skipped: false,
          reason: "catch-up",
        });
        if (ticks.length > 12) ticks.shift();
      }, i * 200);
    }
  }
}
</script>

<template>
  <div class="visualizer">
    <div class="visualizer-controls">
      <button class="visualizer-btn" @click="killLeader" :disabled="!leader">Kill Leader</button>
      <button class="visualizer-btn" :class="{ active: paused }" @click="togglePause">
        {{ paused ? "Resume" : "Pause" }}
      </button>
      <button class="visualizer-btn" @click="addInstance">+ Instance</button>
      <button class="visualizer-btn" @click="removeInstance">- Instance</button>
      <label class="strategy-toggle">
        <input type="checkbox" v-model="overlap" />
        <span>Allow overlap</span>
      </label>
      <label class="visualizer-label">
        Missed:
        <select v-model="missedPolicy" class="visualizer-select">
          <option value="skip">skip</option>
          <option value="catch-up">catch-up</option>
          <option value="catch-up-limit:3">catch-up-limit:3</option>
        </select>
      </label>
    </div>

    <!-- Scheduler instances -->
    <div class="scheduler-section">
      <div class="section-label">Scheduler Instances</div>
      <div class="instances">
        <div
          v-for="inst in instances"
          :key="inst.id"
          class="instance"
          :class="inst.state"
          @click="reviveInstance(inst)"
        >
          <span v-if="inst.state === 'leader'" class="crown">&#128081;</span>
          <span class="inst-label">Node {{ inst.id }}</span>
          <span class="inst-state">{{ inst.state }}</span>
        </div>
      </div>
    </div>

    <!-- Timeline -->
    <div class="scheduler-section">
      <div class="section-label">
        Dispatch Timeline
        <span v-if="jobActive" class="job-active-badge">job active</span>
      </div>
      <div class="timeline">
        <TransitionGroup name="tick">
          <div
            v-for="tick in ticks"
            :key="tick.id"
            class="tick-mark"
            :class="{
              dispatched: tick.dispatched,
              skipped: tick.skipped,
              catchup: tick.reason === 'catch-up',
            }"
          >
            <div class="tick-dot" />
            <span class="tick-label">{{ tick.dispatched ? (tick.reason === "catch-up" ? "catch-up" : "dispatched") : tick.reason || "skipped" }}</span>
          </div>
        </TransitionGroup>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scheduler-section {
  margin-bottom: 1rem;
}

.section-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.job-active-badge {
  font-size: 0.6875rem;
  font-weight: 600;
  color: #f59e0b;
  background: #f59e0b18;
  padding: 2px 8px;
  border-radius: 8px;
  animation: pulse-soft 1s infinite;
}

.instances {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.instance {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.625rem 1rem;
  border-radius: 10px;
  border: 2px solid var(--vp-c-border);
  background: var(--vp-c-bg);
  transition: all 0.3s ease;
  min-width: 80px;
  cursor: default;
}

.instance.leader {
  border-color: #22c55e;
  background: #22c55e0a;
  box-shadow: 0 0 12px rgba(34, 197, 94, 0.15);
}

.instance.follower {
  opacity: 0.6;
}

.instance.dead {
  opacity: 0.3;
  border-style: dashed;
  cursor: pointer;
}

.crown {
  font-size: 1.125rem;
  margin-bottom: 2px;
}

.inst-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.inst-state {
  font-size: 0.625rem;
  color: var(--vp-c-text-3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.timeline {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  min-height: 50px;
}

.tick-mark {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.tick-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--vp-c-border);
  transition: all 0.2s ease;
}

.tick-mark.dispatched .tick-dot {
  background: #22c55e;
}

.tick-mark.skipped .tick-dot {
  background: transparent;
  border: 2px solid var(--vp-c-border);
}

.tick-mark.catchup .tick-dot {
  background: #3b82f6;
}

.tick-label {
  font-size: 0.5625rem;
  color: var(--vp-c-text-3);
  white-space: nowrap;
}

.tick-mark.dispatched .tick-label { color: #22c55e; }
.tick-mark.catchup .tick-label { color: #3b82f6; }

.tick-enter-active { transition: all 0.3s ease; }
.tick-enter-from { opacity: 0; transform: scale(0); }

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
