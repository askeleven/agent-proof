/**
 * Take -> finished cut: the hook as its own opening card, then the take
 * speed-ramped per step (never cut), a step bar that follows the marks, and
 * optionally a chat panel above the recording with each message appearing at
 * its real time.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { planSegments, trimLeadIn } from './plan.js'
import { hookHtml, stepBarHtml, chatHtml } from './overlays.js'
import { assertFfmpeg, runFfmpeg } from './capture.js'

export const HOOK_SECONDS = 2.8
const FPS = 30

/**
 * Build the ffmpeg filter graph. Inputs are, in order: [0] the take, [1] the
 * hook card (when there is one), then one PNG per step, then one PNG per chat
 * state. Pure, so the timing logic is testable without ffmpeg.
 *
 * @param {object} p
 * @param {import('./plan.js').Segment[]} p.segs
 * @param {number} p.head          Seconds trimmed from the start of the take.
 * @param {number[]} p.stepStarts  Output time each step's bar appears.
 * @param {number} p.length        Cut length without the hook.
 * @param {{ width: number, height: number }} p.frame  Finished frame size.
 * @param {boolean} p.hook
 * @param {number} [p.chatHeight]  Height of the chat panel, 0 for none.
 * @param {number[]} [p.chatStarts] Output time each chat state appears (state k shows k messages).
 * @returns {{ filter: string, stepInput: number, chatInput: number }}
 */
export function buildFilterGraph({ segs, head, stepStarts, length, frame, hook, chatHeight = 0, chatStarts = [] }) {
  const stepInput = hook ? 2 : 1
  const chatInput = stepInput + stepStarts.length
  const parts = []

  segs.forEach((s, i) => {
    parts.push(`[0:v]trim=start=${(s.from + head).toFixed(3)}:end=${(s.to + head).toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed.toFixed(4)}[s${i}]`)
  })
  const pad = chatHeight > 0 ? `,pad=${frame.width}:${frame.height}:0:${chatHeight}:color=white` : ''
  parts.push(`${segs.map((_, i) => `[s${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=${FPS}${pad}[c0]`)

  let chain = '[c0]'
  chatStarts.forEach((from, k) => {
    const to = k + 1 < chatStarts.length ? chatStarts[k + 1] : length + 1
    parts.push(`${chain}[${chatInput + k}:v]overlay=0:0:enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'[p${k}]`)
    chain = `[p${k}]`
  })
  stepStarts.forEach((from, i) => {
    const to = i + 1 < stepStarts.length ? stepStarts[i + 1] : length + 1
    parts.push(`${chain}[${stepInput + i}:v]overlay=0:0:enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'[v${i}]`)
    chain = `[v${i}]`
  })

  if (hook) {
    parts.push(`[1:v]scale=${frame.width}:${frame.height},format=yuv420p,fps=${FPS},setsar=1,fade=t=out:st=${(HOOK_SECONDS - 0.35).toFixed(2)}:d=0.35[intro]`)
    parts.push(`${chain}format=yuv420p,setsar=1[body]`)
    parts.push('[intro][body]concat=n=2:v=1:a=0[out]')
  } else {
    parts.push(`${chain}format=yuv420p,setsar=1[out]`)
  }
  return { filter: parts.join(';'), stepInput, chatInput }
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} html
 * @param {string} file
 * @param {boolean} transparent
 */
async function shoot(page, html, file, transparent) {
  await page.setContent(html)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: file, omitBackground: transparent })
}

/**
 * @param {import('./config.js').Config} config
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {Promise<{ file: string, length: number }>}
 */
export async function compose(config, opts = {}) {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`))
  assertFfmpeg()
  /** @type {import('./record.js').Timeline} */
  const tl = JSON.parse(readFileSync(join(config.out, 'timeline.json'), 'utf8'))

  // Only configured steps, in configured order, each at its first mark.
  const marks = config.steps.map((label) => tl.marks.find((m) => m.label === label) ?? null)
  const missing = config.steps.filter((_, i) => !marks[i])
  if (missing.length) throw new Error(`the take never reached: ${missing.join(', ')}. Re-record, or drop them from steps.`)
  const present = /** @type {Array<{ label: string, t: number }>} */ (marks)

  const work = { duration: tl.duration, marks: present.map((m) => ({ ...m })), messages: tl.messages.map((m) => ({ ...m })) }
  const head = trimLeadIn(work, config.cut.leadIn)
  const plan = planSegments(work.duration, work.marks, config.cut)

  const chatHeight = config.chat ? config.chat.height : 0
  const frame = { width: tl.size.width, height: tl.size.height + chatHeight }
  const fontDataUrl = config.brand.font ? `data:font/woff2;base64,${readFileSync(config.brand.font).toString('base64')}` : undefined
  const brand = { ...config.brand, fontDataUrl }

  const dir = join(config.out, 'overlays')
  mkdirSync(dir, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(config.chrome.executablePath ? { executablePath: config.chrome.executablePath } : { channel: config.chrome.channel }),
  })
  const inputs = ['-i', join(config.out, 'raw.mp4')]
  try {
    const page = await browser.newPage({ viewport: frame })
    page.setDefaultTimeout(30000)
    if (config.hook) {
      const f = join(dir, 'hook.png')
      await shoot(page, hookHtml({ hook: config.hook, ...frame, brand }), f, false)
      inputs.push('-loop', '1', '-t', String(HOOK_SECONDS), '-i', f)
    }
    for (let i = 0; i < config.steps.length; i++) {
      const f = join(dir, `step${i}.png`)
      await shoot(page, stepBarHtml({ steps: config.steps, active: i, ...frame, brand }), f, true)
      inputs.push('-loop', '1', '-i', f)
    }
    if (config.chat) {
      await page.setViewportSize({ width: frame.width, height: chatHeight })
      for (let k = 0; k <= work.messages.length; k++) {
        const f = join(dir, `chat${k}.png`)
        await shoot(page, chatHtml({ messages: work.messages.slice(0, k), title: config.chat.title, subtitle: config.chat.subtitle, width: frame.width, height: chatHeight }), f, false)
        inputs.push('-loop', '1', '-i', f)
      }
    }
  } finally {
    await browser.close()
  }

  const chatStarts = config.chat ? [0, ...work.messages.map((m) => plan.toOut(m.t))] : []
  const { filter } = buildFilterGraph({
    segs: plan.segs,
    head,
    stepStarts: plan.stepStarts,
    length: plan.length,
    frame,
    hook: Boolean(config.hook),
    chatHeight,
    chatStarts,
  })
  const total = plan.length + (config.hook ? HOOK_SECONDS : 0)
  const file = join(config.out, 'final.mp4')
  runFfmpeg([
    '-y', ...inputs,
    '-filter_complex', filter,
    '-map', '[out]',
    '-t', total.toFixed(3),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'medium', '-movflags', '+faststart',
    file,
  ])
  writeFileSync(join(config.out, 'cut.json'), JSON.stringify({ head, segs: plan.segs, stepStarts: plan.stepStarts, length: total }, null, 2))
  log(`wrote ${file} (${total.toFixed(1)}s, ${frame.width}x${frame.height})`)
  return { file, length: total }
}
