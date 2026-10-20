/**
 * Screen capture through the Chrome DevTools screencast. It sends a frame only
 * when pixels change, each stamped with its real time, which is what lets a
 * take run for many minutes without storing thousands of identical frames -
 * and why encode() has to hold the last frame to the real stop time.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * @typedef {{ file: string, t: number }} Frame  `t` is epoch seconds.
 */

/**
 * @param {import('playwright-core').BrowserContext} ctx
 * @param {import('playwright-core').Page} page
 * @param {string} framesDir
 * @returns {Promise<{ frames: Frame[], start: () => Promise<unknown>, stop: () => Promise<unknown> }>}
 */
export async function startCapture(ctx, page, framesDir) {
  mkdirSync(framesDir, { recursive: true })
  /** @type {Frame[]} */
  const frames = []
  const cdp = await ctx.newCDPSession(page)
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = join(framesDir, `${String(frames.length).padStart(6, '0')}.jpg`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 })
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  return {
    frames,
    start: () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 }),
    stop: () => cdp.send('Page.stopScreencast'),
  }
}

/**
 * The ffmpeg concat list for variable-rate frames. Each frame lasts until the
 * next one; the last lasts until `stopAt`, so a static ending is kept.
 * @param {Frame[]} frames
 * @param {number} stopAt epoch seconds
 */
export function concatList(frames, stopAt) {
  const lines = frames.map((f, i) => {
    const next = frames[i + 1]?.t ?? Math.max(stopAt, f.t + 1)
    return `file '${f.file.replace(/'/g, "'\\''")}'\nduration ${(next - f.t).toFixed(4)}`
  })
  return `${lines.join('\n')}\nfile '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'\n`
}

/**
 * Frames -> constant-rate H.264 at the device size. Returns the take length.
 * @param {{ frames: Frame[], stopAt: number, outFile: string, listFile: string, width: number, height: number, fps?: number }} p
 */
export function encode({ frames, stopAt, outFile, listFile, width, height, fps = 30 }) {
  if (frames.length === 0) throw new Error('no frames were captured - did the page render anything?')
  writeFileSync(listFile, concatList(frames, stopAt))
  runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `scale=${width}:${height}:flags=lanczos,fps=${fps}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-movflags', '+faststart',
    outFile,
  ])
  return Math.max(stopAt, frames[frames.length - 1].t + 1) - frames[0].t
}

/** Fails early with an install hint instead of a spawn error mid-recording. */
export function assertFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) {
    throw new Error('ffmpeg was not found on PATH. Install it (macOS: brew install ffmpeg, Debian/Ubuntu: apt install ffmpeg) and try again.')
  }
}

/** @param {string[]} args */
export function runFfmpeg(args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`ffmpeg failed:\n${(r.stderr ?? '').slice(-1500)}`)
}
