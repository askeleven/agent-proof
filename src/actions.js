/**
 * The small set of browser actions a config can script: enough to log in,
 * open a page, fill the form that sets an agent off, and move the view when a
 * step begins. Anything more elaborate belongs in an .mjs config.
 */

import { actionValue } from './config.js'

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {import('playwright-core').Page} page
 * @param {import('./config.js').Action[]} actions
 */
export async function runActions(page, actions) {
  for (const a of actions) {
    if ('goto' in a) {
      await page.goto(a.goto)
      await page.waitForLoadState('domcontentloaded')
    } else if ('fill' in a) {
      await page.fill(a.fill, actionValue(a))
    } else if ('type' in a) {
      const el = page.locator(a.type).first()
      await el.click()
      await el.pressSequentially(actionValue(a), { delay: a.delay ?? 35 })
    } else if ('click' in a) {
      await page.locator(a.click).first().click()
    } else if ('press' in a) {
      await page.keyboard.press(a.press)
    } else if ('wait' in a) {
      await sleep(a.wait * 1000)
    } else if ('waitFor' in a) {
      await page.locator(a.waitFor).first().waitFor()
    }
  }
}
