/**
 * The three overlays, as plain HTML strings a headless browser screenshots:
 * the hook card, the step bar (one state per step), and the chat panel (one
 * state per message). Pure functions of their inputs, so they are testable
 * without a browser.
 */

/**
 * @typedef {object} Brand
 * @property {string} [bar]         Step bar and hook background.
 * @property {string} [active]      Current step chip background.
 * @property {string} [activeText]  Current step chip text.
 * @property {string} [fontFamily]  CSS family name to use.
 * @property {string} [fontDataUrl] woff2 data URL, embedded so no file:// load can stall.
 */

export const DEFAULT_BRAND = Object.freeze({
  bar: '#0F1D30',
  active: '#EFEEE2',
  activeText: '#1F3A5F',
})

/** @param {string} text */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** @param {Brand} brand */
function fontCss(brand) {
  const face = brand.fontDataUrl
    ? `@font-face { font-family: AgentProof; src: url(${brand.fontDataUrl}) format('woff2'); font-weight: 100 900; }`
    : ''
  const family = brand.fontDataUrl ? 'AgentProof, ' : brand.fontFamily ? `${brand.fontFamily}, ` : ''
  return { face, family: `${family}system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif` }
}

/**
 * Full-frame hook card, shown on its own before the footage starts.
 * @param {{ hook: string, width: number, height: number, brand?: Brand }} p
 */
export function hookHtml({ hook, width, height, brand = {} }) {
  const b = { ...DEFAULT_BRAND, ...brand }
  const f = fontCss(b)
  return `<!doctype html><html><head><style>
${f.face}
html, body { margin: 0; width: ${width}px; height: ${height}px; font-family: ${f.family}; }
.hook { position: absolute; inset: 0; background: ${b.bar}; display: flex; align-items: center; justify-content: center; padding: 0 ${Math.round(width * 0.09)}px; box-sizing: border-box; }
.hook h1 { color: #fff; font-size: ${Math.round(width * 0.085)}px; line-height: 1.08; font-weight: 700; letter-spacing: -0.02em; text-wrap: balance; margin: 0; }
</style></head><body><div class="hook"><h1>${escapeHtml(hook)}</h1></div></body></html>`
}

/**
 * Transparent frame with the step bar at the bottom, `active` highlighted.
 * @param {{ steps: string[], active: number, width: number, height: number, brand?: Brand }} p
 */
export function stepBarHtml({ steps, active, width, height, brand = {} }) {
  const b = { ...DEFAULT_BRAND, ...brand }
  const f = fontCss(b)
  const s = width / 1080
  const chips = steps
    .map((label, i) => {
      const state = i < active ? 'done' : i === active ? 'now' : 'next'
      return `<div class="chip ${state}"><span class="n">${i + 1}</span>${escapeHtml(label)}</div>`
    })
    .join('<div class="arrow"></div>')
  return `<!doctype html><html><head><style>
${f.face}
html, body { margin: 0; width: ${width}px; height: ${height}px; background: transparent; font-family: ${f.family}; }
.bar { position: absolute; left: ${40 * s}px; right: ${40 * s}px; bottom: ${56 * s}px; background: ${b.bar}; opacity: 0.96; border-radius: ${36 * s}px; padding: ${30 * s}px; display: flex; flex-wrap: wrap; gap: ${14 * s}px ${10 * s}px; align-items: center; justify-content: center; box-shadow: 0 ${18 * s}px ${50 * s}px rgba(0,0,0,0.35); }
.chip { font-size: ${34 * s}px; font-weight: 600; padding: ${14 * s}px ${22 * s}px; border-radius: 999px; display: flex; gap: ${12 * s}px; align-items: center; }
.chip .n { font-size: ${24 * s}px; width: ${38 * s}px; height: ${38 * s}px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; }
.done { color: rgba(255,255,255,0.72); }
.done .n { background: rgba(255,255,255,0.18); color: #fff; }
.now { background: ${b.active}; color: ${b.activeText}; }
.now .n { background: ${b.activeText}; color: #fff; }
.next { color: rgba(255,255,255,0.38); }
.next .n { border: ${2 * s}px solid rgba(255,255,255,0.3); }
.arrow { width: ${18 * s}px; height: ${2 * s}px; background: rgba(255,255,255,0.3); }
</style></head><body><div class="bar">${chips}</div></body></html>`
}

/**
 * Chat formatting a business line sends: *bold* and stray markdown **bold**.
 * @param {string} text
 */
export function chatFormat(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>')
}

/**
 * The other party's phone, as a messaging app shows it: their own messages
 * (dir "in", sent to your agent) on the right, your agent's replies on the left.
 * @param {{ messages: Array<{ dir: 'in' | 'out', text: string }>, title: string, subtitle?: string, width: number, height: number }} p
 */
export function chatHtml({ messages, title, subtitle = '', width, height }) {
  const s = width / 1080
  const bubbles = messages
    .map((m) => `<div class="b ${m.dir === 'in' ? 'me' : 'them'}">${chatFormat(m.text)}</div>`)
    .join('')
  return `<!doctype html><html><head><style>
html, body { margin: 0; width: ${width}px; height: ${height}px; font-family: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif; }
body { background: #EFE7DE; display: flex; flex-direction: column; overflow: hidden; }
.head { height: ${118 * s}px; background: #F6F6F6; border-bottom: 1px solid #D8D8D8; display: flex; align-items: center; gap: ${22 * s}px; padding: 0 ${36 * s}px; flex: none; }
.av { width: ${72 * s}px; height: ${72 * s}px; border-radius: 50%; background: #1F3A5F; color: #fff; display: flex; align-items: center; justify-content: center; font-size: ${30 * s}px; font-weight: 600; }
.name { font-size: ${36 * s}px; font-weight: 600; color: #111; }
.sub { font-size: ${24 * s}px; color: #667781; margin-top: ${4 * s}px; }
.feed { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; gap: ${14 * s}px; padding: ${24 * s}px ${32 * s}px; overflow: hidden; }
.b { max-width: 78%; font-size: ${29 * s}px; line-height: 1.32; padding: ${16 * s}px ${22 * s}px; border-radius: ${22 * s}px; color: #111; box-shadow: 0 1px 1px rgba(0,0,0,0.12); }
.me { align-self: flex-end; background: #D9FDD3; border-top-right-radius: ${6 * s}px; }
.them { align-self: flex-start; background: #fff; border-top-left-radius: ${6 * s}px; }
</style></head><body>
<div class="head"><div class="av">${escapeHtml(title.slice(0, 1))}</div><div><div class="name">${escapeHtml(title)}</div>${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ''}</div></div>
<div class="feed">${bubbles}</div>
</body></html>`
}
