import {
  type AnySignature,
  ChordSignature,
  type InferOutputTuple,
  type Signature,
} from "./signature.js";

/**
 * Group + callback — parallel execution, then merge.
 * Header results are collected as a tuple and passed to the callback.
 */
export function chord<T extends AnySignature[], CO>(
  header: [...T],
  callback: Signature<InferOutputTuple<T>, CO>,
): ChordSignature<CO> {
  if (header.length === 0) {
    throw new Error("chord() requires at least one header signature");
  }
  return new ChordSignature<CO>(header, callback as AnySignature);
}
