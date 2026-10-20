/**
 * One take: open the UI, start capturing, let the agent work, and turn its
 * events into a timeline. Nothing here decides when a step happened except
 * the events themselves.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { runActions } from './actions.js'
import { startCapture, encode, assertFfmpeg } from './capture.js'
import { EventBus, tailFile, serveEvents, pollCommand } from './events.js'

/**
 * @typedef {object} Timeline
 * @property {number} duration  Take length, seconds.
 * @property {Array<{ label: string, t: number }>} marks  Seconds from the take's first frame.
 * @property {Array<{ dir: 'in' | 'out', text: string, t: number }>} messages
 * @property {{ width: number, height: number }} size  Pixel size of raw.mp4.
 * @property {boolean} completed  Whether the stop step (or done) was reached.
 */

/**
 * @param {import('./config.js').Config} config
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {Promise<Timeline>}
 */
export async function record(config, opts = {}) {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`))
  assertFfmpeg()
  rmSync(join(config.out, 'frames'), { recursive: true, force: true })
  mkdirSync(config.out, { recursive: true })

  const bus = new EventBus()
  /** @type {Array<() => unknown>} */
  const cleanups = []
  if (config.events.http) {
    const server = await serveEvents(bus, config.events.http.port)
    cleanups.push(server.close)
    log(`events: POST to http://127.0.0.1:${server.port}`)
  }
  if (config.events.file) {
    cleanups.push(await tailFile(bus, config.events.file))
    log(`events: tailing ${config.events.file}`)
  }
  if (config.events.poll) {
    cleanups.push(pollCommand(bus, config.events.poll.command, config.events.poll.every))
    log(`events: polling "${config.events.poll.command}" every ${config.events.poll.every}s`)
  }

  if (config.launch) {
    const url = config.events.http ? `http://127.0.0.1:${config.events.http.port}` : ''
    const child = spawn(config.launch.command, {
      shell: true,
      cwd: config.baseDir,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...(url ? { AGENT_PROOF_URL: url } : {}), ...(config.events.file ? { AGENT_PROOF_FILE: config.events.file } : {}) },
    })
    cleanups.push(() => child.kill())
    log(`launched: ${config.launch.command}`)
    if (config.launch.waitFor) await waitForUrl(config.launch.waitFor, 60)
  }

  let browser
  try {
    browser = await chromium.launch({
      headless: config.chrome.headless,
      ...(config.chrome.executablePath ? { executablePath: config.chrome.executablePath } : { channel: config.chrome.channel }),
    })
  } catch (err) {
    for (const c of cleanups) await c()
    throw new Error(
      `could not start Chrome (${/** @type {Error} */ (err).message.split('\n')[0]}). ` +
        'Install Google Chrome, or set chrome.executablePath in the config.',
    )
  }

  try {
    const ctx = await browser.newContext({
      viewport: { width: config.viewport.width, height: config.viewport.height },
      deviceScaleFactor: config.viewport.scale,
    })
    const page = await ctx.newPage()
    page.setDefaultTimeout(30000)
    await runActions(page, config.setup)

    const cap = await startCapture(ctx, page, join(config.out, 'frames'))
    /** @type {Array<{ label: string, at: number }>} */
    const steps = []
    /** @type {Array<{ dir: 'in' | 'out', text: string, at: number }>} */
    const messages = []
    /** @type {Array<{ label: string }>} */
    const pendingViews = []
    let finished = false
    bus.on('step', (s) => {
      if (!config.steps.includes(s.label)) {
        log(`ignored step "${s.label}" (not in config.steps)`)
        return
      }
      steps.push(s)
      log(`step: ${s.label}`)
      if (config.on[s.label]) pendingViews.push(s)
      if (s.label === config.stop.after) finished = true
    })
    bus.on('message', (m) => messages.push(m))
    bus.on('done', () => {
      finished = true
    })

    await cap.start()
    const startedAt = Date.now() / 1000
    await runActions(page, config.start)

    // Run view changes in order as their steps arrive, until the stop step.
    const deadline = startedAt + config.stop.timeout
    while (!finished && Date.now() / 1000 < deadline) {
      const next = pendingViews.shift()
      if (next) await runActions(page, config.on[next.label])
      else await new Promise((r) => setTimeout(r, 250))
    }
    for (const v of pendingViews.splice(0)) await runActions(page, config.on[v.label])
    if (!finished) log(`timed out after ${config.stop.timeout}s before "${config.stop.after}"`)
    await new Promise((r) => setTimeout(r, config.stop.hold * 1000))

    const stopAt = Date.now() / 1000
    await cap.stop()
    const t0 = cap.frames[0]?.t ?? startedAt
    const size = { width: config.viewport.width * config.viewport.scale, height: config.viewport.height * config.viewport.scale }
    const duration = encode({
      frames: cap.frames,
      stopAt,
      outFile: join(config.out, 'raw.mp4'),
      listFile: join(config.out, 'frames.txt'),
      ...size,
    })

    /** @type {Timeline} */
    const timeline = {
      duration,
      marks: steps.map((s) => ({ label: s.label, t: Math.max(0, s.at - t0) })),
      messages: messages.sort((a, b) => a.at - b.at).map((m) => ({ dir: m.dir, text: m.text, t: Math.max(0, m.at - t0) })),
      size,
      completed: finished,
    }
    writeFileSync(join(config.out, 'timeline.json'), JSON.stringify(timeline, null, 2))
    log(`wrote ${join(config.out, 'raw.mp4')} (${duration.toFixed(0)}s, ${cap.frames.length} frames)`)
    return timeline
  } finally {
    await browser.close()
    for (const c of cleanups) await c()
  }
}

/**
 * @param {string} url
 * @param {number} seconds
 */
async function waitForUrl(url, seconds) {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`launch.waitFor: ${url} did not come up within ${seconds}s`)
}
