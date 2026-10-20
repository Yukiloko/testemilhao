/** Two-proportion z-test. Returns the two-sided p-value of variant vs control. */
export function twoProportionPValue(convA: number, nA: number, convB: number, nB: number): number {
  if (nA === 0 || nB === 0) return 1;
  const pA = convA / nA;
  const pB = convB / nB;
  const pooled = (convA + convB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) return 1;
  const z = Math.abs(pA - pB) / se;
  return 2 * (1 - normalCdf(z));
}

function normalCdf(z: number): number {
  // Abramowitz-Stegun 26.2.17, max error 7.5e-8.
  const t = 1 / (1 + 0.2316419 * z);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) * poly;
}
