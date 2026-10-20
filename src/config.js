/**
 * Loading and checking a recording config. A config is JSON, or an .mjs file
 * whose default export is the same object (handy for computed URLs).
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CUT } from './plan.js'

/**
 * @typedef {{ goto: string }
 *   | { fill: string, value?: string, env?: string }
 *   | { type: string, value?: string, env?: string, delay?: number }
 *   | { click: string }
 *   | { press: string }
 *   | { wait: number }
 *   | { waitFor: string }} Action
 */

/**
 * @typedef {object} Config
 * @property {string} out
 * @property {{ width: number, height: number, scale: number }} viewport
 * @property {{ channel?: string, executablePath?: string, headless: boolean }} chrome
 * @property {{ command: string, waitFor: string | null } | null} launch  Optional process to start first (your agent, or the app it drives). It gets AGENT_PROOF_URL.
 * @property {Action[]} setup   Before recording starts (log in, open the page).
 * @property {Action[]} start   First thing on camera (e.g. filling the form that triggers the agent).
 * @property {Record<string, Action[]>} on  Actions to run when a step begins.
 * @property {{ http?: { port: number }, file?: string, poll?: { command: string, every: number } }} events
 * @property {string[]} steps   Caption labels, in order.
 * @property {{ after: string | null, hold: number, timeout: number }} stop
 * @property {{ target: number, minStep: number, maxStep: number, leadIn: number | null }} cut
 * @property {string | null} hook
 * @property {{ title: string, subtitle: string, height: number } | null} chat
 * @property {{ bar?: string, active?: string, activeText?: string, font?: string | null }} brand
 * @property {string} baseDir  Directory relative paths resolve against.
 */

const ACTION_KEYS = ['goto', 'fill', 'type', 'click', 'press', 'wait', 'waitFor']

/**
 * @param {unknown} a
 * @param {string} where
 * @param {string[]} problems
 */
function checkAction(a, where, problems) {
  if (!a || typeof a !== 'object') {
    problems.push(`${where}: an action must be an object`)
    return
  }
  const keys = Object.keys(a).filter((k) => ACTION_KEYS.includes(k))
  if (keys.length !== 1) {
    problems.push(`${where}: needs exactly one of ${ACTION_KEYS.join(', ')}`)
    return
  }
  const o = /** @type {Record<string, unknown>} */ (a)
  if ((keys[0] === 'fill' || keys[0] === 'type') && o.value === undefined && o.env === undefined) {
    problems.push(`${where}: ${keys[0]} needs "value" or "env"`)
  }
  if (keys[0] === 'wait' && typeof o.wait !== 'number') problems.push(`${where}: wait is seconds (a number)`)
}

/**
 * Fill defaults and validate. Throws one error listing every problem found.
 * @param {Record<string, any>} raw
 * @param {string} [baseDir]
 * @returns {Config}
 */
export function normaliseConfig(raw, baseDir = process.cwd()) {
  /** @type {string[]} */
  const problems = []
  if (!raw || typeof raw !== 'object') throw new Error('config must be an object')

  const steps = Array.isArray(raw.steps) ? raw.steps.filter((s) => typeof s === 'string' && s.trim()) : []
  if (steps.length === 0) problems.push('steps: list at least one caption label')
  if (new Set(steps).size !== steps.length) problems.push('steps: labels must be unique')

  const events = raw.events ?? {}
  if (!events.http && !events.file && !events.poll) {
    problems.push('events: configure at least one source (http, file or poll)')
  }
  if (events.poll && (typeof events.poll.command !== 'string' || !events.poll.command)) {
    problems.push('events.poll.command: required')
  }

  for (const [i, a] of (raw.setup ?? []).entries()) checkAction(a, `setup[${i}]`, problems)
  for (const [i, a] of (raw.start ?? []).entries()) checkAction(a, `start[${i}]`, problems)
  for (const [label, list] of Object.entries(raw.on ?? {})) {
    if (!steps.includes(label)) problems.push(`on.${label}: not one of the steps`)
    for (const [i, a] of (Array.isArray(list) ? list : []).entries()) checkAction(a, `on.${label}[${i}]`, problems)
  }

  const after = raw.stop?.after ?? steps[steps.length - 1] ?? null
  if (after && !steps.includes(after)) problems.push(`stop.after: "${after}" is not one of the steps`)

  const viewport = { width: 540, height: 960, scale: 2, ...(raw.viewport ?? {}) }
  if (viewport.width * viewport.scale % 2 || viewport.height * viewport.scale % 2) {
    problems.push('viewport: width*scale and height*scale must be even (H.264 needs even dimensions)')
  }

  if (raw.launch && typeof (typeof raw.launch === 'string' ? raw.launch : raw.launch.command) !== 'string') {
    problems.push('launch: a command string, or { command, waitFor }')
  }

  if (problems.length) throw new Error(`invalid config:\n  - ${problems.join('\n  - ')}`)

  const abs = (/** @type {string} */ p) => (isAbsolute(p) ? p : resolve(baseDir, p))
  return {
    out: abs(raw.out ?? 'out'),
    viewport,
    chrome: { channel: 'chrome', headless: true, ...(raw.chrome ?? {}) },
    launch: raw.launch
      ? typeof raw.launch === 'string'
        ? { command: raw.launch, waitFor: null }
        : { command: raw.launch.command, waitFor: raw.launch.waitFor ?? null }
      : null,
    setup: raw.setup ?? [],
    start: raw.start ?? [],
    on: raw.on ?? {},
    events: {
      ...(events.http ? { http: { port: events.http.port ?? 4747 } } : {}),
      ...(events.file ? { file: abs(events.file) } : {}),
      ...(events.poll ? { poll: { command: events.poll.command, every: events.poll.every ?? 3 } } : {}),
    },
    steps,
    stop: { after, hold: raw.stop?.hold ?? 6, timeout: raw.stop?.timeout ?? 900 },
    cut: { ...DEFAULT_CUT, leadIn: null, ...(raw.cut ?? {}) },
    hook: typeof raw.hook === 'string' && raw.hook.trim() ? raw.hook : null,
    // The panel sits above the recording, so the finished frame is taller by its
    // height. 2/3 of the width with a 540x600@2 viewport gives exactly 1080x1920.
    chat: raw.chat ? { title: raw.chat.title ?? 'Chat', subtitle: raw.chat.subtitle ?? '', height: raw.chat.height ?? Math.round((viewport.width * viewport.scale * 2) / 3) } : null,
    brand: { ...(raw.brand ?? {}), font: raw.brand?.font ? abs(raw.brand.font) : null },
    baseDir,
  }
}

/**
 * @param {string} path  .json or .mjs
 * @returns {Promise<Config>}
 */
export async function loadConfig(path) {
  const full = resolve(path)
  const raw = full.endsWith('.mjs') || full.endsWith('.js')
    ? (await import(pathToFileURL(full).href)).default
    : JSON.parse(await readFile(full, 'utf8'))
  return normaliseConfig(raw, dirname(full))
}

/**
 * The text an action types, from `value` or the named environment variable.
 * Secrets only ever come from the environment, never from the config file.
 * @param {{ value?: string, env?: string }} a
 */
export function actionValue(a) {
  if (a.env !== undefined) {
    const v = process.env[a.env]
    if (v === undefined) throw new Error(`environment variable ${a.env} is not set`)
    return v
  }
  return String(a.value ?? '')
}
