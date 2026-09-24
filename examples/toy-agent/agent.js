/**
 * A scripted stand-in for a real agent, so the example runs with no API keys.
 * It serves a small support inbox and works one ticket, updating the page and
 * calling mark() the moment each step actually starts - which is exactly how a
 * real agent should call it.
 *
 * In a real integration you replace the body of work() with your agent and
 * keep the mark() calls at the points where its steps begin.
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { mark, done } from '../../src/mark.js'

const PORT = Number(process.env.TOY_PORT ?? 4800)
const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8')

const state = {
  tickets: /** @type {Array<Record<string, unknown>>} */ ([]),
  open: /** @type {string | null} */ (null),
  customer: /** @type {Record<string, string> | null} */ (null),
  lookup: false,
  reply: '',
  status: 'Waiting for new tickets',
}

let viewed = false
createServer((req, res) => {
  if (req.url === '/state') {
    viewed = true
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(state))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page)
}).listen(PORT, '127.0.0.1')

/** @param {number} s */
const pause = (s) => new Promise((r) => setTimeout(r, s * 1000))

const REPLY =
  "Hi Priya, thanks for flagging this. I can see order #4821 was charged twice on May 3 because the first payment timed out at the bank. I've refunded the duplicate $129.00 to your Visa ending 4417; it should show within 3 to 5 business days. Nothing else is needed on your side. Sorry for the hassle. - Support"

async function work() {
  while (!viewed) await pause(0.2)
  await pause(2)

  await mark('Ticket arrives')
  state.tickets.push({ id: 'T-1042', from: 'Priya Raman', subject: 'Charged twice for my order', age: 'just now', status: 'New' })
  state.status = 'New ticket'
  await pause(3)

  await mark('Reads it')
  state.open = 'T-1042'
  state.status = 'Reading T-1042'
  await pause(4)

  await mark('Looks up the account')
  state.lookup = true
  state.status = 'Looking up Priya Raman'
  await pause(5)
  state.customer = { Plan: 'Pro, annual', 'Order #4821': '$129.00 on May 3', Payments: '2 charges, 1 timed out at bank', Card: 'Visa ending 4417' }
  await pause(3)

  await mark('Refunds and drafts')
  state.status = 'Refund issued, drafting reply'
  for (let i = 0; i < REPLY.length; i += 6) {
    state.reply = REPLY.slice(0, i + 6)
    await pause(0.25)
  }
  await pause(2)

  await mark('Replies and closes')
  state.tickets[0].status = 'Closed'
  state.status = 'Reply sent, ticket closed'
  await pause(1)
  await done()
}

work().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
