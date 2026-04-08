<template>
  <a
    class="testing-matrix"
    href="https://github.com/kravetsone/taskora/actions/workflows/test.yml"
    target="_blank"
    rel="noopener noreferrer"
    aria-label="View the Taskora cross-runtime test matrix runs on GitHub Actions"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 380"
      role="img"
      aria-labelledby="tm-title tm-desc"
      class="testing-matrix__svg"
    >
      <title id="tm-title">Taskora cross-runtime test matrix</title>
      <desc id="tm-desc">
        Five CI cells: Node 24 + ioredis, Node 20 + ioredis, Bun 1.3+ + ioredis, Bun 1.3+ +
        Bun.RedisClient, and Deno 2.x + ioredis. Each cell passes 300 of 300 integration tests,
        totaling 1,500 live-Redis test runs per push.
      </desc>

      <!-- Header -->
      <text
        x="360"
        y="34"
        fill="var(--vp-c-text-1)"
        font-size="18"
        font-weight="650"
        text-anchor="middle"
        letter-spacing="0.2"
      >Battle-tested on every push</text>
      <text
        x="360"
        y="54"
        fill="var(--vp-c-text-3)"
        font-size="11"
        font-weight="500"
        text-anchor="middle"
        letter-spacing="1.4"
      >RUNTIME × DRIVER MATRIX</text>

      <!-- Cell 1: Node 24 + Node 20 (both Node LTS lines, same driver) -->
      <g transform="translate(40, 82)">
        <rect width="300" height="108" rx="10" fill="var(--vp-c-bg-soft)" />
        <rect width="300" height="108" rx="10" fill="none" stroke="var(--vp-c-border)" stroke-width="1.5" />
        <circle cx="36" cy="54" r="18" fill="var(--vp-c-green-soft)" />
        <circle cx="36" cy="54" r="18" fill="none" stroke="var(--vp-c-green-1)" stroke-width="2.25" />
        <path d="M28 54 l6 6 l10 -12" stroke="var(--vp-c-green-1)" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" fill="none" />

        <text x="72" y="46" fill="var(--vp-c-text-1)" font-size="16" font-weight="650">Node 24 · Node 20</text>
        <text x="72" y="66" fill="var(--vp-c-text-3)" font-size="12.5" font-weight="500">taskora/redis → ioredis</text>
        <text x="72" y="88" fill="var(--vp-c-green-1)" font-size="13" font-weight="600" font-variant-numeric="tabular-nums">300 / 300 per version</text>
      </g>

      <!-- Cell 2: Bun + ioredis -->
      <g transform="translate(380, 82)">
        <rect width="300" height="108" rx="10" fill="var(--vp-c-bg-soft)" />
        <rect width="300" height="108" rx="10" fill="none" stroke="var(--vp-c-border)" stroke-width="1.5" />
        <circle cx="36" cy="54" r="18" fill="var(--vp-c-green-soft)" />
        <circle cx="36" cy="54" r="18" fill="none" stroke="var(--vp-c-green-1)" stroke-width="2.25" />
        <path d="M28 54 l6 6 l10 -12" stroke="var(--vp-c-green-1)" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" fill="none" />

        <text x="72" y="46" fill="var(--vp-c-text-1)" font-size="16" font-weight="650">
          Bun 1.3<tspan fill="var(--vp-c-text-3)" font-size="12" font-weight="500">+</tspan>
        </text>
        <text x="72" y="66" fill="var(--vp-c-text-3)" font-size="12.5" font-weight="500">taskora/redis/ioredis</text>
        <text x="72" y="88" fill="var(--vp-c-green-1)" font-size="13" font-weight="600" font-variant-numeric="tabular-nums">300 / 300 integration tests</text>
      </g>

      <!-- Cell 3: Bun + BunDriver -->
      <g transform="translate(40, 214)">
        <rect width="300" height="108" rx="10" fill="var(--vp-c-bg-soft)" />
        <rect width="300" height="108" rx="10" fill="none" stroke="var(--vp-c-border)" stroke-width="1.5" />
        <circle cx="36" cy="54" r="18" fill="var(--vp-c-green-soft)" />
        <circle cx="36" cy="54" r="18" fill="none" stroke="var(--vp-c-green-1)" stroke-width="2.25" />
        <path d="M28 54 l6 6 l10 -12" stroke="var(--vp-c-green-1)" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" fill="none" />

        <text x="72" y="46" fill="var(--vp-c-text-1)" font-size="16" font-weight="650">
          Bun 1.3<tspan fill="var(--vp-c-text-3)" font-size="12" font-weight="500">+</tspan>
        </text>
        <text x="72" y="66" fill="var(--vp-c-text-3)" font-size="12.5" font-weight="500">taskora/redis/bun (Bun.RedisClient)</text>
        <text x="72" y="88" fill="var(--vp-c-green-1)" font-size="13" font-weight="600" font-variant-numeric="tabular-nums">300 / 300 integration tests</text>
      </g>

      <!-- Cell 4: Deno + ioredis -->
      <g transform="translate(380, 214)">
        <rect width="300" height="108" rx="10" fill="var(--vp-c-bg-soft)" />
        <rect width="300" height="108" rx="10" fill="none" stroke="var(--vp-c-border)" stroke-width="1.5" />
        <circle cx="36" cy="54" r="18" fill="var(--vp-c-green-soft)" />
        <circle cx="36" cy="54" r="18" fill="none" stroke="var(--vp-c-green-1)" stroke-width="2.25" />
        <path d="M28 54 l6 6 l10 -12" stroke="var(--vp-c-green-1)" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" fill="none" />

        <text x="72" y="46" fill="var(--vp-c-text-1)" font-size="16" font-weight="650">Deno 2.x</text>
        <text x="72" y="66" fill="var(--vp-c-text-3)" font-size="12.5" font-weight="500">taskora/redis via npm: specifier</text>
        <text x="72" y="88" fill="var(--vp-c-green-1)" font-size="13" font-weight="600" font-variant-numeric="tabular-nums">300 / 300 integration tests</text>
      </g>

      <!-- Footer totals -->
      <text
        x="360"
        y="356"
        fill="var(--vp-c-text-1)"
        font-size="14"
        font-weight="600"
        text-anchor="middle"
        letter-spacing="0.3"
        font-variant-numeric="tabular-nums"
      >1,500 live-Redis integration test runs per push</text>
    </svg>
  </a>
</template>

<style scoped>
.testing-matrix {
  display: block;
  margin: 1.5rem auto;
  max-width: 720px;
  /* Reset <a> defaults so the wrapper reads as a visual card, not a text link. */
  text-decoration: none;
  color: inherit;
  border-radius: 12px;
  transition:
    transform 0.18s ease-out,
    filter 0.18s ease-out;
}
.testing-matrix:hover {
  /* Subtle lift + slight brighten on hover so the link affordance is
     discoverable without turning the whole graphic into a button. */
  transform: translateY(-2px);
  filter: brightness(1.05);
}
.testing-matrix:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 4px;
}
.testing-matrix__svg {
  width: 100%;
  height: auto;
  display: block;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
</style>
