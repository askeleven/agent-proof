/**
 * The piece your agent imports. Zero dependencies.
 *
 *   import { mark } from '@askeleven/agent-proof/mark'
 *   await mark('Drafts')
 *
 * Where events go, in order of preference:
 *   AGENT_PROOF_URL   POST to a running recorder, e.g. http://127.0.0.1:4747
 *   AGENT_PROOF_FILE  append a JSON line to this file
 * With neither set every call is a no-op, so leaving mark() in production
 * code costs nothing.
 *
 * Call it when a step has actually started, not when you intend to start it:
 * the video will show the caption at exactly that moment.
 */

import { appendFile } from 'node:fs/promises'

/**
 * @param {Record<string, unknown>} event
 * @param {{ url?: string, file?: string }} [target]
 * @returns {Promise<boolean>} whether the event was delivered somewhere
 */
export async function emit(event, target = {}) {
  const url = target.url ?? process.env.AGENT_PROOF_URL
  const file = target.file ?? process.env.AGENT_PROOF_FILE
  const line = JSON.stringify(event)
  if (url) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: line })
      return res.ok
    } catch {
      // A recorder that is not running must never break the agent.
      return false
    }
  }
  if (file) {
    await appendFile(file, `${line}\n`)
    return true
  }
  return false
}

/**
 * A step began. `at` (epoch seconds) overrides the time if you know it better.
 * @param {string} label
 * @param {{ at?: number, url?: string, file?: string }} [opts]
 */
export function mark(label, opts = {}) {
  const { at, ...target } = opts
  return emit({ type: 'step', label, ...(at === undefined ? {} : { at }) }, target)
}

/**
 * A chat message, for the phone panel. "in" is sent to your agent, "out" is
 * your agent's reply.
 * @param {'in' | 'out'} dir
 * @param {string} text
 * @param {{ at?: number, url?: string, file?: string }} [opts]
 */
export function message(dir, text, opts = {}) {
  const { at, ...target } = opts
  return emit({ type: 'message', dir, text, ...(at === undefined ? {} : { at }) }, target)
}

/**
 * The task is finished; the recorder holds the last frame and stops.
 * @param {{ url?: string, file?: string }} [opts]
 */
export function done(opts = {}) {
  return emit({ type: 'done' }, opts)
}
