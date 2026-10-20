/**
 * @askeleven/agent-proof
 *
 * Record an agent doing a real task as one uncut vertical video, with captions
 * placed by the agent's own step events.
 */

import { record } from './record.js'
import { compose } from './compose.js'

export { record } from './record.js'
export { compose, buildFilterGraph, HOOK_SECONDS } from './compose.js'
export { loadConfig, normaliseConfig } from './config.js'
export { planSegments, trimLeadIn, DEFAULT_CUT } from './plan.js'
export { parseEvent, EventBus } from './events.js'
export { mark, message, done } from './mark.js'

/**
 * Record a take, then compose it.
 * @param {import('./config.js').Config} config
 * @param {{ log?: (line: string) => void }} [opts]
 */
export async function run(config, opts = {}) {
  const timeline = await record(config, opts)
  if (!timeline.completed) {
    throw new Error(`the take stopped before "${config.stop.after}"; raw.mp4 and timeline.json are kept in ${config.out}`)
  }
  return compose(config, opts)
}
