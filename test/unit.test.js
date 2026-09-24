import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planSegments, trimLeadIn } from '../src/plan.js'
import { parseEvent, EventBus, tailFile, serveEvents } from '../src/events.js'
import { normaliseConfig, actionValue } from '../src/config.js'
import { escapeHtml, chatFormat, stepBarHtml, hookHtml } from '../src/overlays.js'
import { buildFilterGraph } from '../src/compose.js'
import { concatList } from '../src/capture.js'
import { mark, message, done } from '../src/mark.js'

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))

// ---- plan ------------------------------------------------------------------

test('planSegments lands near the target and keeps every step on screen', () => {
  const plan = planSegments(240, [{ t: 1 }, { t: 30 }, { t: 110 }, { t: 170 }, { t: 200 }], { target: 45, minStep: 3, maxStep: 10 })
  assert.ok(plan.length > 30 && plan.length < 50, `length ${plan.length}`)
  for (const s of plan.segs) {
    const out = s.outTo - s.outFrom
    assert.ok(s.speed >= 1)
    assert.ok(out <= 10 + 1e-9, `segment on screen ${out}s`)
  }
  assert.deepEqual(plan.stepStarts.map((t) => Math.round(t * 10) / 10), plan.stepStarts.map((t) => Math.round(t * 10) / 10).sort((a, b) => a - b))
})

test('planSegments never speeds up below real time and clamps out-of-range marks', () => {
  const plan = planSegments(10, [{ t: 2 }, { t: 50 }], { target: 45 })
  assert.equal(plan.segs[0].speed, 1)
  assert.equal(plan.toOut(-5), 0)
  assert.ok(Math.abs(plan.toOut(50) - plan.length) < 1e-9)
})

test('trimLeadIn drops idle footage before the first mark and shifts everything', () => {
  const tl = { duration: 200, marks: [{ t: 65 }, { t: 77 }], messages: [{ t: 65 }] }
  const head = trimLeadIn(tl, 2)
  assert.equal(head, 63)
  assert.equal(tl.duration, 137)
  assert.deepEqual(tl.marks.map((m) => m.t), [2, 14])
  assert.equal(tl.messages[0].t, 2)
  assert.equal(trimLeadIn({ duration: 10, marks: [{ t: 1 }] }, 2), 0)
  assert.equal(trimLeadIn({ duration: 10, marks: [{ t: 5 }] }, null), 0)
})

// ---- events ----------------------------------------------------------------

test('parseEvent accepts the three shapes and ignores everything else', () => {
  assert.deepEqual(parseEvent('{"type":"step","label":" Drafts "}'), { type: 'step', label: 'Drafts' })
  assert.deepEqual(parseEvent({ type: 'message', dir: 'in', text: 'hi', at: 5 }), { type: 'message', dir: 'in', text: 'hi', at: 5 })
  assert.deepEqual(parseEvent('{"type":"done"}'), { type: 'done' })
  for (const bad of ['', 'not json', '{"type":"step"}', '{"type":"message","dir":"sideways","text":"x"}', 'null', '42']) {
    assert.equal(parseEvent(bad), null, bad)
  }
})

test('EventBus keeps the first report of each step and each message', () => {
  const bus = new EventBus()
  /** @type {string[]} */
  const seen = []
  bus.on('step', (s) => seen.push(`step:${s.label}`))
  bus.on('message', (m) => seen.push(`msg:${m.text}`))
  bus.on('done', () => seen.push('done'))
  bus.pushLines('{"type":"step","label":"A","at":10}\n{"type":"step","label":"A","at":20}\nnoise\n{"type":"message","dir":"in","text":"hi","at":3}')
  bus.pushLines('{"type":"message","dir":"in","text":"hi","at":3}\n{"type":"done"}\n{"type":"done"}')
  assert.deepEqual(seen, ['step:A', 'msg:hi', 'done'])
})

test('tailFile reads only lines written after it starts, including split writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-proof-'))
  const file = join(dir, 'events.jsonl')
  writeFileSync(file, '{"type":"step","label":"Old"}\n')
  const bus = new EventBus()
  /** @type {string[]} */
  const labels = []
  bus.on('step', (s) => labels.push(s.label))
  const stop = await tailFile(bus, file, 50)
  appendFileSync(file, '{"type":"step","la')
  await sleep(120)
  appendFileSync(file, 'bel":"New"}\n')
  await sleep(200)
  stop()
  assert.deepEqual(labels, ['New'])
})

test('serveEvents accepts posts and mark() delivers to it', async () => {
  const bus = new EventBus()
  /** @type {string[]} */
  const got = []
  bus.on('step', (s) => got.push(s.label))
  bus.on('message', (m) => got.push(`${m.dir}:${m.text}`))
  bus.on('done', () => got.push('done'))
  const server = await serveEvents(bus, 0)
  const url = `http://127.0.0.1:${server.port}`
  assert.equal(await mark('Researches', { url }), true)
  assert.equal(await message('out', 'Thanks!', { url }), true)
  assert.equal(await done({ url }), true)
  await server.close()
  assert.deepEqual(got, ['Researches', 'out:Thanks!', 'done'])
})

test('mark() appends to a file, and is a silent no-op with nowhere to go', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agent-proof-')), 'e.jsonl')
  await mark('Drafts', { file, at: 123 })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { type: 'step', label: 'Drafts', at: 123 })
  const saved = { url: process.env.AGENT_PROOF_URL, file: process.env.AGENT_PROOF_FILE }
  delete process.env.AGENT_PROOF_URL
  delete process.env.AGENT_PROOF_FILE
  assert.equal(await mark('Nowhere'), false)
  assert.equal(await mark('Unreachable', { url: 'http://127.0.0.1:1' }), false)
  if (saved.url) process.env.AGENT_PROOF_URL = saved.url
  if (saved.file) process.env.AGENT_PROOF_FILE = saved.file
})

// ---- config ----------------------------------------------------------------

test('normaliseConfig fills defaults and resolves paths against the config', () => {
  const c = normaliseConfig({ steps: ['A', 'B'], events: { file: 'e.jsonl' } }, '/work')
  assert.equal(c.out, '/work/out')
  assert.equal(c.events.file, '/work/e.jsonl')
  assert.equal(c.stop.after, 'B')
  assert.deepEqual(c.viewport, { width: 540, height: 960, scale: 2 })
  assert.equal(c.chat, null)
  const chat = normaliseConfig({ steps: ['A'], events: { http: {} }, chat: { title: 'Shop' }, viewport: { width: 540, height: 600, scale: 2 } })
  assert.equal(chat.chat?.height, 720)
  assert.equal(chat.events.http?.port, 4747)
})

test('normaliseConfig reports every problem at once', () => {
  assert.throws(
    () => normaliseConfig({ steps: ['A', 'A'], on: { Z: [{ goto: 'x' }] }, setup: [{ fill: '#e' }, { goto: 'a', click: 'b' }], stop: { after: 'Q' } }),
    (err) => {
      const msg = /** @type {Error} */ (err).message
      for (const part of ['unique', 'at least one source', 'on.Z', 'setup[0]', 'setup[1]', 'stop.after']) {
        assert.ok(msg.includes(part), `missing "${part}" in:\n${msg}`)
      }
      return true
    },
  )
})

test('actionValue reads secrets from the environment only', () => {
  process.env.AGENT_PROOF_TEST_SECRET = 's3cret'
  assert.equal(actionValue({ env: 'AGENT_PROOF_TEST_SECRET' }), 's3cret')
  assert.equal(actionValue({ value: 'plain' }), 'plain')
  assert.throws(() => actionValue({ env: 'AGENT_PROOF_DEFINITELY_UNSET' }), /not set/)
})

// ---- overlays --------------------------------------------------------------

test('overlays escape user text', () => {
  assert.equal(escapeHtml('<b>"x" & y</b>'), '&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;')
  assert.equal(chatFormat('**Hi** <there>\nnext'), '<b>Hi</b> &lt;there&gt;<br>next')
  assert.ok(hookHtml({ hook: '<script>', width: 1080, height: 1920 }).includes('&lt;script&gt;'))
  const bar = stepBarHtml({ steps: ['One', 'Two', 'Three'], active: 1, width: 1080, height: 1920 })
  assert.ok(bar.includes('chip done') && bar.includes('chip now') && bar.includes('chip next'))
})

// ---- composition -----------------------------------------------------------

test('buildFilterGraph without a chat panel', () => {
  const plan = planSegments(60, [{ t: 1 }, { t: 30 }])
  const { filter, stepInput } = buildFilterGraph({ segs: plan.segs, head: 0, stepStarts: plan.stepStarts, length: plan.length, frame: { width: 1080, height: 1920 }, hook: true })
  assert.equal(stepInput, 2)
  assert.ok(filter.includes('concat=n=3:v=1:a=0,fps=30[c0]'))
  assert.ok(!filter.includes('pad='))
  assert.ok(filter.includes('[2:v]overlay') && filter.includes('[3:v]overlay'))
  assert.ok(filter.endsWith('[intro][body]concat=n=2:v=1:a=0[out]'))
})

test('buildFilterGraph with a chat panel pads the take under it and offsets trims by the lead-in', () => {
  const plan = planSegments(30, [{ t: 2 }, { t: 10 }])
  const { filter, chatInput } = buildFilterGraph({
    segs: plan.segs, head: 63, stepStarts: plan.stepStarts, length: plan.length,
    frame: { width: 1080, height: 1920 }, hook: false, chatHeight: 720, chatStarts: [0, 2, 9],
  })
  assert.equal(chatInput, 3)
  assert.ok(filter.includes('trim=start=63.000'))
  assert.ok(filter.includes('pad=1080:1920:0:720:color=white'))
  assert.ok(filter.includes('[3:v]overlay') && filter.includes('[5:v]overlay'))
  assert.ok(filter.endsWith('format=yuv420p,setsar=1[out]'))
})

test('concatList holds the last frame until the real stop', () => {
  const list = concatList([{ file: '/f/0.jpg', t: 100 }, { file: "/f/it's.jpg", t: 101.5 }], 130)
  assert.ok(list.includes("file '/f/0.jpg'\nduration 1.5000"))
  assert.ok(list.includes('duration 28.5000'))
  assert.ok(list.includes("it'\\''s.jpg"))
})
