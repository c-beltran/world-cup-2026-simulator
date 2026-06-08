// Deterministic, seedable RNG + Poisson sampler.
// Seeding everything means the whole tournament is reproducible: a featured sim
// can be replayed exactly in Stage 3 from just its master seed + index.

// mulberry32: tiny, fast, good-enough 32-bit PRNG. Returns a function -> [0,1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derive a well-mixed per-sim seed from a master seed + sim index (splitmix-style).
export function simSeed(master, index) {
  let h = (master ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Knuth's algorithm. Fine for the small means (~0.2-2.2) this model produces.
export function poisson(rng, lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}
