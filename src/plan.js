/**
 * How a take becomes a cut: split the recording at each step and give every
 * segment its own speed. Nothing is removed from the middle - the take stays
 * one continuous run - only how fast each part plays changes.
 */

/**
 * @typedef {object} CutOptions
 * @property {number} [target]  Finished length to aim for, seconds.
 * @property {number} [minStep] Least time a step stays on screen, seconds.
 * @property {number} [maxStep] Most time a step stays on screen, seconds, so a
 *   stretch spent waiting on a human does not eat the cut.
 */

/**
 * @typedef {object} Segment
 * @property {number} from    Source start, seconds.
 * @property {number} to      Source end, seconds.
 * @property {number} speed   Playback multiplier, never below 1.
 * @property {number} outFrom Start in the finished cut, seconds.
 * @property {number} outTo   End in the finished cut, seconds.
 */

/**
 * @typedef {object} Plan
 * @property {Segment[]} segs
 * @property {number[]} stepStarts   Each mark's start in the finished cut.
 * @property {number} length         Finished length, seconds (hook not included).
 * @property {(t: number) => number} toOut  Map any source time into the cut.
 */

export const DEFAULT_CUT = Object.freeze({ target: 45, minStep: 3, maxStep: 10 })

/**
 * @param {number} duration              Take length, seconds.
 * @param {Array<{ t: number }>} marks   Step marks, seconds from the take's start.
 * @param {CutOptions} [opts]
 * @returns {Plan}
 */
export function planSegments(duration, marks, opts = {}) {
  const { target, minStep, maxStep } = { ...DEFAULT_CUT, ...opts }
  if (!(duration > 0)) throw new Error('planSegments: duration must be positive')

  const inside = marks.map((m) => m.t).filter((t) => t > 0 && t < duration)
  const bounds = [0, ...[...new Set(inside)].sort((a, b) => a - b), duration]

  /** @type {Segment[]} */
  const segs = []
  for (let i = 0; i < bounds.length - 1; i++) {
    segs.push({ from: bounds[i], to: bounds[i + 1], speed: 1, outFrom: 0, outTo: 0 })
  }

  const budget = Math.max(target, segs.length * minStep)
  let out = 0
  for (const s of segs) {
    const len = s.to - s.from
    const share = Math.min(maxStep, Math.max(minStep, (len / duration) * budget))
    s.speed = Math.max(1, len / share)
    s.outFrom = out
    out += len / s.speed
    s.outTo = out
  }

  /** @param {number} t */
  const toOut = (t) => {
    const seg = segs.find((s) => t >= s.from && t <= s.to) ?? (t < 0 ? segs[0] : segs[segs.length - 1])
    const clamped = Math.min(Math.max(t, seg.from), seg.to)
    return Math.max(0, seg.outFrom + (clamped - seg.from) / seg.speed)
  }

  return { segs, stepStarts: marks.map((m) => toOut(m.t)), length: out, toOut }
}

/**
 * Idle footage before the task begins (a take often waits on a real trigger)
 * is dropped by shifting everything so the cut opens `leadIn` seconds before
 * the first mark. Returns the seconds removed from the head.
 *
 * @param {{ duration: number, marks: Array<{ t: number }>, messages?: Array<{ t: number }> }} timeline  Mutated in place.
 * @param {number | null | undefined} leadIn
 * @returns {number}
 */
export function trimLeadIn(timeline, leadIn) {
  if (leadIn == null || timeline.marks.length === 0) return 0
  const first = Math.min(...timeline.marks.map((m) => m.t))
  const head = Math.max(0, first - leadIn)
  if (head === 0) return 0
  timeline.duration -= head
  for (const m of timeline.marks) m.t -= head
  for (const m of timeline.messages ?? []) m.t -= head
  return head
}
