/**
 * Rounding policy (PROPOSED — decision 5 still open).
 * The engine never rounds: Excel doesn't, and we must match it to floating-point precision.
 * Round ONLY (a) for display and (b) when persisting a snapshot, with these decimals:
 *   money 2 dp · rates 4 dp · factors/percentages 4 dp. Half rounds away from zero.
 */
export const ROUNDING = { money: 2, rate: 4, factor: 4 } as const;

export function roundHalfAway(x: number, dp: number): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** dp;
  return (Math.sign(x) * Math.round((Math.abs(x) + Number.EPSILON) * f)) / f;
}
export const roundMoney = (x: number) => roundHalfAway(x, ROUNDING.money);
export const roundRate = (x: number) => roundHalfAway(x, ROUNDING.rate);
export const roundFactor = (x: number) => roundHalfAway(x, ROUNDING.factor);
