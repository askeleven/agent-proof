/**
 * Records the toy example end to end. Needs Chrome and ffmpeg, so it only runs
 * when asked: AGENT_PROOF_E2E=1 node --test test/e2e.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { run } from '../src/index.js'

test('toy example records and composes to a 1080x1920 H.264 cut', { skip: !process.env.AGENT_PROOF_E2E, timeout: 300000 }, async () => {
  const config = await loadConfig(fileURLToPath(new URL('../examples/toy-agent/agent-proof.config.json', import.meta.url)))
  const { file, length } = await run(config, { log: () => {} })
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  assert.equal(probe.stdout.trim(), 'h264,1080,1920,30/1')
  assert.ok(length > 12 && length < 40, `length ${length}`)
})
