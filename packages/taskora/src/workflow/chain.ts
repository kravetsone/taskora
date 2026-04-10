import { type AnySignature, ChainSignature, type Signature } from "./signature.js";

// ── chain() — type-safe sequential pipeline ─────────────────────────
// Overloads for up to 10 steps with compile-time output→input checking.

export function chain<A, B>(s1: Signature<A, B>): ChainSignature<A, B>;
export function chain<A, B, C>(s1: Signature<A, B>, s2: Signature<B, C>): ChainSignature<A, C>;
export function chain<A, B, C, D>(
  s1: Signature<A, B>,
  s2: Signature<B, C>,
  s3: Signature<C, D>,
): ChainSignature<A, D>;
export function chain<A, B, C, D, E>(
  s1: Signature<A, B>,
  s2: Signature<B, C>,
  s3: Signature<C, D>,
  s4: Signature<D, E>,
): ChainSignature<A, E>;
export function chain<A, B, C, D, E, F>(
  s1: Signature<A, B>,
  s2: Signature<B, C>,
  s3: Signature<C, D>,
  s4: Signature<D, E>,
  s5: Signature<E, F>,
): ChainSignature<A, F>;
export function chain<A, B, C, D, E, F, G>(
  s1: Signature<A, B>,
  s2: Signature<B, C>,
  s3: Signature<C, D>,
  s4: Signature<D, E>,
  s5: Signature<E, F>,
  s6: Signature<F, G>,
): ChainSignature<A, G>;
export function chain<A, B, C, D, E, F, G, H>(
  s1: Signature<A, B>,
  s2: Signature<B, C>,
  s3: Signature<C, D>,
  s4: Signature<D, E>,
  s5: Signature<E, F>,
  s6: Signature<F, G>,
  s7: Signature<G, H>,
): ChainSignature<A, H>;
export function chain<A, B, C, D, E, F, G, H, I>(
  s1: Signature<A, B>,
  s2: Signature<B, C>,
  s3: Signature<C, D>,
  s4: Signature<D, E>,
  s5: Signature<E, F>,
  s6: Signature<F, G>,
  s7: Signature<G, H>,
  s8: Signature<H, I>,
): ChainSignature<A, I>;
export function chain<A, B, C, D, E, F, G, H, I, J>(
  s1: Signature<A, B>,
  s2: Signature<B, C>,
  s3: Signature<C, D>,
  s4: Signature<D, E>,
  s5: Signature<E, F>,
  s6: Signature<F, G>,
  s7: Signature<G, H>,
  s8: Signature<H, I>,
  s9: Signature<I, J>,
): ChainSignature<A, J>;
export function chain<A, B, C, D, E, F, G, H, I, J, K>(
  s1: Signature<A, B>,
  s2: Signature<B, C>,
  s3: Signature<C, D>,
  s4: Signature<D, E>,
  s5: Signature<E, F>,
  s6: Signature<F, G>,
  s7: Signature<G, H>,
  s8: Signature<H, I>,
  s9: Signature<I, J>,
  s10: Signature<J, K>,
): ChainSignature<A, K>;
// Fallback for mixed compositions or >10 steps (loses type safety)
export function chain(...steps: AnySignature[]): ChainSignature<unknown, unknown>;
export function chain(...steps: AnySignature[]): ChainSignature<unknown, unknown> {
  if (steps.length === 0) {
    throw new Error("chain() requires at least one step");
  }
  return new ChainSignature(steps);
}
