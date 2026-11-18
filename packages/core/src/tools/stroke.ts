export type Point = [number, number];
export type StrokeAction = { stroke: Point[]; ms?: number };
/** Position in the main screenshot and elapsed milliseconds since button down. */
export type StrokeSample = [number, number, number];

const MAX_POINTS = 128;
const MAX_MOVES = 256;
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** One mouse stroke, validated in full before either backend touches the button. */
export function planStroke({ stroke, ms }: StrokeAction, width: number, height: number): StrokeSample[] {
  if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > MAX_POINTS)
    throw new Error(`stroke needs 2 to ${MAX_POINTS} points from the main screenshot.`);
  if (ms !== undefined && !(Number.isFinite(ms) && ms >= 16 && ms <= 2000))
    throw new Error('stroke ms must be between 16 and 2000.');
  const points: Point[] = [];
  for (const p of stroke) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) throw new Error('Each stroke point must be a finite [x, y] pair.');
    if (p[0] < 0 || p[0] > width - 1 || p[1] < 0 || p[1] > height - 1)
      throw new Error(`Stroke point [${p}] is outside the ${width}×${height} picture.`);
    const prev = points.at(-1);
    if (!prev || p[0] !== prev[0] || p[1] !== prev[1]) points.push(p);
  }
  if (points.length < 2) throw new Error('stroke needs at least two distinct points.');

  // Centripetal Catmull-Rom. Unequal knot intervals keep a short detail beside a long sweep from looping.
  const knots = points.slice(1).map((p, i) => Math.sqrt(distance(p, points[i])));
  const tangents = points.map((p, i) => {
    const prev = points[i - 1], next = points[i + 1];
    const a = knots[i - 1], b = knots[i];
    return p.map((v, axis) => {
      if (!prev) return (next[axis] - v) / b;
      if (!next) return (v - prev[axis]) / a;
      return ((v - prev[axis]) / a * b + (next[axis] - v) / b * a) / (a + b);
    });
  });
  const fine: StrokeSample[] = [[...points[0], 0]];
  const ends = [0];
  let length = 0;
  for (let i = 0; i < knots.length; i++) {
    const a = points[i], b = points[i + 1], k = knots[i];
    const steps = Math.min(64, Math.max(4, Math.ceil(k * k / 4)));
    for (let j = 1; j <= steps; j++) {
      const t = j / steps, u = 1 - t;
      const at = (axis: number, limit: number) => {
        const v = u * u * (1 + 2 * t) * a[axis] + t * t * (1 + 2 * u) * b[axis]
          + t * u * k * (u * tangents[i][axis] - t * tangents[i + 1][axis]);
        return Math.max(0, Math.min(limit - 1, v));
      };
      const x = at(0, width), y = at(1, height), last = fine[fine.length - 1];
      length += Math.hypot(x - last[0], y - last[1]);
      fine.push([x, y, length]);
    }
    ends.push(fine.length - 1);
  }

  // Sample by travelled distance, including every knot and a short first move for drag thresholds.
  // Keep extra samples bounded even for 128 knots on opposite sides of the screen.
  const duration = ms ?? Math.max(32, Math.min(1200, length / 1.2));
  const spacing = Math.max(4, Math.min(12, length * 16 / duration), length / (MAX_MOVES - points.length));
  const out: StrokeSample[] = [[...points[0], 0]];
  let cursor = 1;
  const emit = (d: number, end: number) => {
    while (cursor < end && fine[cursor][2] < d) cursor++;
    const a = fine[cursor - 1], b = fine[cursor];
    const t = b[2] > a[2] ? (d - a[2]) / (b[2] - a[2]) : 1;
    const time = Math.max(out[out.length - 1][2] + 8, Math.round(duration * d / length));
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, time]);
  };
  for (let i = 1; i < ends.length; i++) {
    const start = fine[ends[i - 1]][2], end = ends[i], len = fine[end][2] - start;
    const count = Math.max(1, Math.ceil(len / spacing));
    if (i === 1 && len / count > 1) emit(Math.min(2, len / count / 2), end);
    for (let j = 1; j <= count; j++) emit(j === count ? fine[end][2] : start + len * j / count, end);
  }
  return out;
}
