/**
 * Proportional rescaling of leaf values to a new total. Pure module: shared by
 * the browser and the Worker.
 */
import { largestRemainder } from './rounding';

/**
 * Scales `leaves` proportionally to their current values so the result sums
 * exactly to `newTotal` (whole cases, largest-remainder rounding). If the
 * current values sum to 0 the new total is split evenly.
 */
export function rescale(leaves: { key: string; value: number }[], newTotal: number): Record<string, number> {
  return largestRemainder(leaves, newTotal);
}
