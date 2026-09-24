/**
 * Where step events come from. Every source yields the same JSON-lines shape:
 *
 *   {"type":"step","label":"Drafts"}
 *   {"type":"message","dir":"in","text":"Hi, I'd like to apply"}
 *   {"type":"done"}
 *
 * Any event may carry `at` (epoch seconds) when the agent knows the true time
 * something happened - a message's send time from a database, say - and the
 * recorder should use that instead of when it heard about it.
 *
 * Sources: a JSONL file that is tailed, a local HTTP endpoint, and a shell
 * command polled on an interval. They all feed one EventBus.
 */

import { createServer } from 'node:http'
import { open, stat } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { EventEmitter } from 'node:events'

/**
 * @typedef {{ type: 'step', label: string, at?: number }
 *   | { type: 'message', dir: 'in' | 'out', text: string, at?: number }
 *   | { type: 'done', at?: number }} AgentEvent
 */

/**
 * Parse one event, or return null for anything that is not a valid event.
 * Invalid lines are ignored rather than fatal: a source may interleave logs.
 * @param {unknown} raw
 * @returns {AgentEvent | null}
 */
export function parseEvent(raw) {
  let v = raw
  if (typeof v === 'string') {
    const line = v.trim()
    if (!line) return null
    try {
      v = JSON.parse(line)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (v)
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : undefined
  const withAt = at === undefined ? {} : { at }
  if (o.type === 'step' && typeof o.label === 'string' && o.label.trim()) {
    return { type: 'step', label: o.label.trim(), ...withAt }
  }
  if (o.type === 'message' && (o.dir === 'in' || o.dir === 'out') && typeof o.text === 'string') {
    return { type: 'message', dir: o.dir, text: o.text, ...withAt }
  }
  if (o.type === 'done') return { type: 'done', ...withAt }
  return null
}

/**
 * Merges sources into one ordered stream. A step label is only accepted once:
 * sources overlap (a poll command re-reports state every tick) and the first
 * report is the moment that step began. Messages are deduplicated by content
 * and time for the same reason.
 */
export class EventBus extends EventEmitter {
  constructor() {
    super()
    /** @type {Set<string>} */
    this.seenSteps = new Set()
    /** @type {Set<string>} */
    this.seenMessages = new Set()
    this.isDone = false
  }

  /**
   * @param {AgentEvent | null} event
   * @returns {boolean} whether the event was new
   */
  push(event) {
    if (!event) return false
    const now = Date.now() / 1000
    const at = event.at ?? now
    if (event.type === 'step') {
      if (this.seenSteps.has(event.label)) return false
      this.seenSteps.add(event.label)
      this.emit('step', { label: event.label, at })
      return true
    }
    if (event.type === 'message') {
      const key = `${event.dir}|${event.at ?? ''}|${event.text}`
      if (this.seenMessages.has(key)) return false
      this.seenMessages.add(key)
      this.emit('message', { dir: event.dir, text: event.text, at })
      return true
    }
    if (this.isDone) return false
    this.isDone = true
    this.emit('done', { at })
    return true
  }

  /** @param {string} chunk Newline-separated events. */
  pushLines(chunk) {
    for (const line of chunk.split('\n')) this.push(parseEvent(line))
  }
}

/**
 * Tail a JSONL file from its current end. Lines already in the file when
 * recording starts belong to an earlier run and are skipped.
 * @param {EventBus} bus
 * @param {string} path
 * @param {number} [everyMs]
 * @returns {Promise<() => void>} stop
 */
export async function tailFile(bus, path, everyMs = 500) {
  let offset = 0
  try {
    offset = (await stat(path)).size
  } catch {
    offset = 0
  }
  let partial = ''
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      const size = (await stat(path)).size
      if (size < offset) offset = 0 // truncated: start over
      if (size > offset) {
        const fh = await open(path, 'r')
        const buf = Buffer.alloc(size - offset)
        await fh.read(buf, 0, buf.length, offset)
        await fh.close()
        offset = size
        const text = partial + buf.toString('utf8')
        const cut = text.lastIndexOf('\n')
        partial = cut === -1 ? text : text.slice(cut + 1)
        if (cut !== -1) bus.pushLines(text.slice(0, cut))
      }
    } catch {
      // Not created yet: keep waiting.
    }
    if (!stopped) timer = setTimeout(tick, everyMs)
  }
  let timer = setTimeout(tick, everyMs)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * A local endpoint agents POST events to: one JSON event, or JSON lines.
 * Binds to 127.0.0.1 only.
 * @param {EventBus} bus
 * @param {number} port
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function serveEvents(bus, port) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => {
      body += c
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      const before = bus.seenSteps.size + bus.seenMessages.size + (bus.isDone ? 1 : 0)
      bus.pushLines(body)
      const after = bus.seenSteps.size + bus.seenMessages.size + (bus.isDone ? 1 : 0)
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: after - before }))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

/**
 * Run a shell command on an interval and treat its stdout as JSON lines. The
 * right fit for agents you cannot change: the command reads their state (a
 * database row, an API) and prints what it sees; the bus drops repeats.
 * @param {EventBus} bus
 * @param {string} command
 * @param {number} everySeconds
 * @returns {() => void} stop
 */
export function pollCommand(bus, command, everySeconds) {
  let stopped = false
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const tick = () => {
    exec(command, { timeout: Math.max(5000, everySeconds * 4000), maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (!err) bus.pushLines(stdout)
      if (!stopped) timer = setTimeout(tick, everySeconds * 1000)
    })
  }
  tick()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
