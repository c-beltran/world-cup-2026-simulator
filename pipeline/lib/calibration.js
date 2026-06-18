// Calibration metrics for the backtest. A "point" is { p, outcome } where p ∈ [0,1] is
// the predicted probability and outcome ∈ {0,1} is whether it happened.

// Brier score: mean squared error of probabilistic predictions. 0 = perfect, lower better.
export function brier(points) {
  if (!points.length) return 0;
  return points.reduce((s, { p, outcome }) => s + (p - outcome) ** 2, 0) / points.length;
}

// Log loss (cross-entropy), clamped to avoid infinities. Lower is better.
export function logloss(points) {
  if (!points.length) return 0;
  const eps = 1e-12;
  return -points.reduce((s, { p, outcome }) => {
    const q = Math.min(1 - eps, Math.max(eps, p));
    return s + (outcome * Math.log(q) + (1 - outcome) * Math.log(1 - q));
  }, 0) / points.length;
}

// Reliability bins: split [0,1] into nbins; for each, the mean predicted probability vs
// the observed frequency. A well-calibrated model has meanP ≈ obs in every populated bin.
export function reliability(points, nbins = 10) {
  const bins = Array.from({ length: nbins }, (_, i) => ({
    lo: i / nbins, hi: (i + 1) / nbins, n: 0, sumP: 0, sumO: 0,
  }));
  for (const { p, outcome } of points) {
    let idx = Math.floor(p * nbins);
    if (idx >= nbins) idx = nbins - 1;
    if (idx < 0) idx = 0;
    bins[idx].n++; bins[idx].sumP += p; bins[idx].sumO += outcome;
  }
  return bins.map((b) => ({
    lo: b.lo, hi: b.hi, n: b.n,
    meanP: b.n ? b.sumP / b.n : 0,
    obs: b.n ? b.sumO / b.n : 0,
  }));
}
