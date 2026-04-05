import type { StandardSchemaV1 } from "@standard-schema/spec";

type MigrationFn = (data: unknown) => unknown;

export interface ResolvedVersion {
  version: number;
  since: number;
}

/**
 * Resolve the effective version and since from task options.
 *
 * - Tuple migrate: version = since + migrate.length
 * - Record migrate: version = explicit (required)
 * - No migrate: version = explicit or 1
 */
export function resolveVersion(opts: {
  version?: number;
  since?: number;
  migrate?: readonly MigrationFn[] | Record<number, MigrationFn>;
}): ResolvedVersion {
  const since = opts.since ?? 1;

  if (Array.isArray(opts.migrate)) {
    // Tuple form — version derived
    return { version: since + opts.migrate.length, since };
  }

  // Record form or no migrate — version must be explicit (or defaults to 1)
  const version = opts.version ?? 1;

  if (version < since) {
    throw new Error(`version (${version}) cannot be less than since (${since})`);
  }

  return { version, since };
}

/**
 * Normalize tuple or record migrations into a Map<sourceVersion, fn>.
 * Key N means "migrate from version N to N+1".
 */
export function normalizeMigrations(
  migrate: readonly MigrationFn[] | Record<number, MigrationFn> | undefined,
  since: number,
): Map<number, MigrationFn> {
  const map = new Map<number, MigrationFn>();

  if (!migrate) return map;

  if (Array.isArray(migrate)) {
    // Tuple: index 0 = since→since+1, index 1 = since+1→since+2, etc.
    for (let i = 0; i < migrate.length; i++) {
      map.set(since + i, migrate[i]);
    }
  } else {
    // Record: keys are source versions
    for (const [key, fn] of Object.entries(migrate)) {
      map.set(Number(key), fn);
    }
  }

  return map;
}

/**
 * Run migrations from `fromVersion` to `toVersion`, skipping gaps.
 * Returns the migrated data.
 */
export function runMigrations(
  data: unknown,
  fromVersion: number,
  toVersion: number,
  migrations: Map<number, MigrationFn>,
): unknown {
  let current = data;
  for (let v = fromVersion; v < toVersion; v++) {
    const fn = migrations.get(v);
    if (fn) {
      current = fn(current);
    }
    // no fn? skip — schema validation will apply .default() values
  }
  return current;
}

/**
 * Type helper for tuple migrations. Locks the return type to the schema's input type.
 * Implementation is identity — the value is in the types.
 */
export function into<S extends StandardSchemaV1>(
  _schema: S,
  fn: (data: unknown) => StandardSchemaV1.InferInput<S>,
): (data: unknown) => StandardSchemaV1.InferInput<S> {
  return fn;
}
