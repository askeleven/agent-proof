#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config.js'
import { record } from '../src/record.js'
import { compose } from '../src/compose.js'

const USAGE = `
agent-proof <command> <config>

  Records an agent doing a real task as one uncut vertical video, with captions
  placed by the agent's own step events. No staging, no edits, no voiceover.

Commands
  run       Record a take, then compose it (the usual one).
  record    Record only: writes raw.mp4 and timeline.json to the out directory.
  compose   Compose only, from an existing raw.mp4 + timeline.json. Use it to
            change the hook, captions or pacing without re-recording.

Options
  --json      Print a machine-readable result.
  --headed    Show the browser while recording.
  --help      This.

Exit codes
  0  video written
  1  the take stopped before its last step, or composing failed
  2  could not run (bad arguments, bad config, Chrome or ffmpeg missing)

Examples
  npx @askeleven/agent-proof run agent-proof.config.json
  npx @askeleven/agent-proof compose agent-proof.config.json
`

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        headed: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (err) {
    process.stderr.write(`${/** @type {Error} */ (err).message}\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed
  const [command, configPath] = positionals
  if (values.help || !command) {
    process.stdout.write(USAGE)
    return values.help ? 0 : 2
  }
  if (!['run', 'record', 'compose'].includes(command) || !configPath) {
    process.stderr.write(`expected: agent-proof <run|record|compose> <config>\n${USAGE}`)
    return 2
  }

  let config
  try {
    config = await loadConfig(configPath)
    if (values.headed) config.chrome.headless = false
  } catch (err) {
    process.stderr.write(`${/** @type {Error} */ (err).message}\n`)
    return 2
  }

  /** @param {Record<string, unknown>} result */
  const report = (result) => {
    if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`)
  }

  try {
    if (command === 'record' || command === 'run') {
      const timeline = await record(config)
      if (!timeline.completed) {
        report({ ok: false, reason: 'incomplete', out: config.out, marks: timeline.marks })
        process.stderr.write(`the take stopped before "${config.stop.after}"; raw.mp4 and timeline.json are in ${config.out}\n`)
        return 1
      }
      if (command === 'record') {
        report({ ok: true, out: config.out, duration: timeline.duration, marks: timeline.marks })
        return 0
      }
    }
    const result = await compose(config)
    report({ ok: true, file: result.file, length: result.length })
    return 0
  } catch (err) {
    const msg = /** @type {Error} */ (err).message
    process.stderr.write(`${msg}\n`)
    return /Chrome|ffmpeg|environment variable/.test(msg) ? 2 : 1
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})
