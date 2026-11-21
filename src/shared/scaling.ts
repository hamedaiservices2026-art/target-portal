/**
 * Proportional rescaling of leaf values to a new total. Pure module: shared by
 * the browser and the Worker.
 *
 * `Rescaler` is the fast form for many rescales over the same leaves (one call
 * per pack): keys are fixed once, values and results are plain number arrays,
 * and nothing is allocated per call. It returns exactly what
 * `largestRemainder` (rounding.ts, the reference) returns for the same input:
 * same shares, same quantized fractions, same order for the leftover cases
 * (fraction desc, then value desc, then key asc). test/shared/scaling.test.ts
 * checks this on random inputs.
 */
import { EPS, FRAC_SCALE } from './rounding';

const TIE_SPAN = 2 ** 21;
const BUCKETS = 256;

export class Rescaler {
  readonly size: number;
  private readonly keys: readonly string[] | null;
  /**
   * Tie-break order (ascending wins): the position of each key in ascending
   * key order (built on first need), or the caller's distinct integers.
   */
  private rank: ArrayLike<number> | null = null;
  /** Largest rank + 1 (for the exact numeric tie key). */
  private rankSpan: number;
  private readonly frac: Float64Array;
  private readonly sorted: Float64Array;
  private readonly tieKey: Float64Array;
  private readonly tieIdx: Int32Array;
  private readonly bucketOf: Uint8Array;
  private readonly counts = new Int32Array(BUCKETS);

  /**
   * Ties after fraction and value go to the smaller key (string order), as in
   * largestRemainder. (`order` is internal: use Rescaler.byOrder.)
   */
  constructor(keys: readonly string[] | null, order: ArrayLike<number> | null = null) {
    let n: number;
    if (keys) {
      if (new Set(keys).size !== keys.length) {
        const seen = new Set<string>();
        const dup = keys.find((k) => (seen.has(k) ? true : (seen.add(k), false)));
        throw new RangeError(`largestRemainder: duplicate key "${dup}"`);
      }
      n = keys.length;
      this.rankSpan = n;
    } else {
      if (!order) throw new RangeError('Rescaler: keys or order is required');
      n = order.length;
      let max = -1;
      const seen = new Set<number>();
      for (let i = 0; i < n; i++) {
        const o = order[i]!;
        if (!Number.isInteger(o) || o < 0 || seen.has(o)) {
          throw new RangeError(`Rescaler.byOrder: order must be distinct integers >= 0, got ${o}`);
        }
        seen.add(o);
        if (o > max) max = o;
      }
      this.rank = order;
      this.rankSpan = max + 1;
    }
    this.keys = keys;
    this.size = n;
    this.frac = new Float64Array(n);
    this.sorted = new Float64Array(n);
    this.tieKey = new Float64Array(n);
    this.tieIdx = new Int32Array(n);
    this.bucketOf = new Uint8Array(n);
  }

  /**
   * Ties after fraction and value go to the smaller `order` number: the same
   * result as keys whose string order is the order of these numbers, with no
   * key strings and no sorting. `order` must be distinct integers >= 0.
   */
  static byOrder(order: ArrayLike<number>): Rescaler {
    return new Rescaler(null, order);
  }

  private ranks(): ArrayLike<number> {
    if (!this.rank) {
      // The default sort compares strings by UTF-16 code units, exactly like
      // byKeyAsc (`<`), and runs natively; keys are unique.
      const keys = this.keys!;
      const pos = new Map([...keys].sort().map((k, i) => [k, i]));
      const rank = new Int32Array(this.size);
      for (let i = 0; i < this.size; i++) rank[i] = pos.get(keys[i]!)!;
      this.rank = rank;
    }
    return this.rank;
  }

  /** The k-th smallest (0-based) of a[0..len): quickselect with a three-way partition (many equal values). Permutes a. */
  private static select(a: Float64Array, len: number, k: number): number {
    let lo = 0;
    let hi = len - 1;
    while (hi > lo) {
      const x = a[lo]!;
      const y = a[(lo + hi) >> 1]!;
      const z = a[hi]!;
      const pivot = x < y ? (y < z ? y : x < z ? z : x) : x < z ? x : y < z ? z : y;
      let lt = lo;
      let gt = hi;
      let i = lo;
      while (i <= gt) {
        const v = a[i]!;
        if (v < pivot) {
          a[i] = a[lt]!;
          a[lt] = v;
          lt++;
          i++;
        } else if (v > pivot) {
          a[i] = a[gt]!;
          a[gt] = v;
          gt--;
        } else i++;
      }
      if (k < lt) hi = lt - 1;
      else if (k > gt) lo = gt + 1;
      else return pivot;
    }
    return a[lo]!;
  }

  /**
   * The r-th largest (1-based) of src[0..len), whose values lie in [min, max]:
   * one histogram pass over BUCKETS value ranges (monotonic, so it keeps the
   * order), then quickselect among the items of the one bucket that holds it.
   * Fewer unpredictable branches than quickselect over everything.
   */
  private kthLargest(src: Float64Array, len: number, r: number, min: number, max: number): number {
    if (min === max) return min;
    const counts = this.counts;
    const bucketOf = this.bucketOf;
    counts.fill(0);
    const scale = BUCKETS / (max - min + 1);
    for (let i = 0; i < len; i++) {
      let b = ((src[i]! - min) * scale) | 0;
      if (b >= BUCKETS) b = BUCKETS - 1;
      bucketOf[i] = b;
      counts[b]!++;
    }
    let above = 0;
    let b = BUCKETS - 1;
    for (; b > 0; b--) {
      const c = counts[b]!;
      if (above + c >= r) break;
      above += c;
    }
    const cand = this.sorted;
    let m = 0;
    for (let i = 0; i < len; i++) if (bucketOf[i] === b) cand[m++] = src[i]!;
    return Rescaler.select(cand, m, m - (r - above));
  }

  /**
   * out[i] = the new whole-case value of key i so that Σ out = target,
   * proportional to values[i] (an even split when every value is 0).
   */
  scale(values: ArrayLike<number>, target: number, out: { [i: number]: number }): void {
    const n = this.size;
    if (!Number.isInteger(target) || target < 0) {
      throw new RangeError(`largestRemainder: target must be a non-negative integer, got ${target}`);
    }
    let rawSum = 0;
    for (let i = 0; i < n; i++) {
      const v = values[i]!;
      if (!Number.isFinite(v) || v < 0) {
        throw new RangeError(`largestRemainder: value for "${this.keys ? this.keys[i] : `#${i}`}" must be a finite number >= 0, got ${v}`);
      }
      rawSum += v;
    }
    if (n === 0) {
      if (target === 0) return;
      throw new RangeError('largestRemainder: cannot distribute a positive target over no items');
    }
    const even = !(rawSum > 0);
    const weightSum = even ? n : rawSum;
    const frac = this.frac;
    // Same float expressions as largestRemainder: share = (weight * target) / weightSum.
    // (`q > 0 ? q : 0` is Math.max(0, q) for these finite q, -0 included.)
    let floorSum = 0;
    let fmin = Infinity;
    let fmax = -Infinity;
    if (even) {
      const share = target / n;
      const floor = Math.floor(share + EPS);
      const q = Math.round((share - floor) * FRAC_SCALE);
      const f = q > 0 ? q : 0;
      for (let i = 0; i < n; i++) {
        out[i] = floor;
        frac[i] = f;
      }
      floorSum = floor * n;
      fmin = fmax = f;
    } else {
      for (let i = 0; i < n; i++) {
        const share = (values[i]! * target) / weightSum;
        const floor = Math.floor(share + EPS);
        out[i] = floor;
        floorSum += floor;
        const q = Math.round((share - floor) * FRAC_SCALE);
        const f = q > 0 ? q : 0;
        frac[i] = f;
        if (f < fmin) fmin = f;
        if (f > fmax) fmax = f;
      }
    }
    const remainder = target - floorSum;
    if (remainder === 0) return;
    const weight = (i: number): number => (even ? 1 : values[i]!); // the slow (sort) paths only
    if (remainder > 0 && remainder < n) {
      // The leftover cases go to the `remainder` first items in order. Find
      // the fraction of the last one; everything above it gets a case, and
      // only items tied at it need the value/key tie-break.
      const threshold = this.kthLargest(frac, n, remainder, fmin, fmax);
      const ties = this.tieIdx;
      let m = 0;
      let given = 0;
      for (let i = 0; i < n; i++) {
        const f = frac[i]!;
        if (f > threshold) {
          out[i]! += 1;
          given++;
        } else if (f === threshold) ties[m++] = i;
      }
      const need = remainder - given;
      if (need === m) {
        for (let k = 0; k < m; k++) out[ties[k]!]! += 1;
        return;
      }
      const rank = this.ranks();
      // Among the tied items the order is value desc, then key asc. With whole
      // values below 2^31 and ranks below 2^21 that order is exactly the
      // number value * 2^21 + (2^21 - 1 - rank) (< 2^52, so exact) descending,
      // and a second quickselect finds the `need` largest; otherwise sort.
      const key = this.tieKey;
      let numeric = this.rankSpan <= TIE_SPAN;
      let kmin = Infinity;
      let kmax = -Infinity;
      for (let k = 0; numeric && k < m; k++) {
        const t = ties[k]!;
        const w = even ? 1 : values[t]!;
        if (!Number.isInteger(w) || w >= 2 ** 31) numeric = false;
        else {
          const x = w * TIE_SPAN + (TIE_SPAN - 1 - rank[t]!);
          key[k] = x;
          if (x < kmin) kmin = x;
          if (x > kmax) kmax = x;
        }
      }
      if (numeric) {
        const cut = this.kthLargest(key, m, need, kmin, kmax);
        for (let k = 0; k < m; k++) if (key[k]! >= cut) out[ties[k]!]! += 1;
        return;
      }
      const list = Array.from(ties.subarray(0, m));
      list.sort((a, b) => weight(b) - weight(a) || rank[a]! - rank[b]!);
      for (let k = 0; k < need; k++) out[list[k]!]! += 1;
      return;
    }
    // Outside [0, n) only through float snapping: the reference's loops, verbatim.
    const rank = this.ranks();
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => frac[b]! - frac[a]! || weight(b) - weight(a) || rank[a]! - rank[b]!);
    let left = remainder;
    for (let i = 0; left > 0; i = (i + 1) % n) {
      out[order[i]!]! += 1;
      left -= 1;
    }
    for (let i = n - 1; left < 0; i = (i - 1 + n) % n) {
      const k = order[i]!;
      if (out[k]! > 0) {
        out[k]! -= 1;
        left += 1;
      }
    }
  }
}

/**
 * Scales `leaves` proportionally to their current values so the result sums
 * exactly to `newTotal` (whole cases, largest-remainder rounding). If the
 * current values sum to 0 the new total is split evenly.
 */
export function rescale(leaves: { key: string; value: number }[], newTotal: number): Record<string, number> {
  const out = new Array<number>(leaves.length);
  new Rescaler(leaves.map((l) => l.key)).scale(leaves.map((l) => l.value), newTotal, out);
  const res: Record<string, number> = {};
  leaves.forEach((l, i) => { res[l.key] = out[i]!; });
  return res;
}
