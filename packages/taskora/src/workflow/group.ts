import { type AnySignature, GroupSignature, type InferOutputTuple } from "./signature.js";

/**
 * Parallel execution — all signatures run concurrently, result is a tuple.
 */
export function group<T extends AnySignature[]>(...sigs: T): GroupSignature<InferOutputTuple<T>> {
  if (sigs.length === 0) {
    throw new Error("group() requires at least one signature");
  }
  return new GroupSignature<InferOutputTuple<T>>(sigs);
}
