#!/usr/bin/env node
/**
 * Capture the dsh-model-parameters settings card UI for the README.
 *
 * Drives a headless Chrome via CDP against the running DSH Web GUI
 * (http://127.0.0.1:3080 by default):
 *   1. Forges a session cookie with the local web-auth secret
 *      (~/.dsh/web-auth/secret) — the GUI is password-gated.
 *   2. Optionally flips the GUI locale for the shot by temporarily writing
 *      `locale.preference` into ~/.dsh/settings.yaml (restored afterwards).
 *   3. Navigates to the GUI, opens the plugin configuration page and the
 *      "Model Parameters" card (.mp-card), expanded.
 *   4. Captures a clipped, 2× screenshot of the card (exact bounds, no
 *      margins) and prints the card text so the language can be verified.
 *
 * Usage:
 *   node scripts/capture-ui.mjs                 # capture → docs/screenshot-card.png
 *   node scripts/capture-ui.mjs --locale zh     # → docs/screenshot-card-zh.png
 *   node scripts/capture-ui.mjs --locale en     # → docs/screenshot-card-en.png
 *   node scripts/capture-ui.mjs --explore       # dump page text + full screenshot
 *
 * Env: DSH_WEB_URL, DSH_WEB_AUTH_DIR, CHROME, OUT
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const SETTINGS_FILE = join(homedir(), '.dsh', 'settings.yaml')

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const LOCALE = arg('--locale')
if (LOCALE !== undefined && !['zh', 'en'].includes(LOCALE)) throw new Error(`--locale must be zh or en, got ${LOCALE}`)
const OUT = process.env.OUT
  || join(ROOT, 'docs', LOCALE ? `screenshot-card-${LOCALE}.png` : 'screenshot-card.png')
const MODE = process.argv.includes('--explore') ? 'explore' : 'card'

// navigation labels per locale (settings sidebar → plugins → plugin config)
const NAV = {
  zh: ['设置', '插件', '插件配置'],
  en: ['Settings', 'Plugins', 'Plugin configuration'],
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 0. flip the GUI locale by temporarily editing the settings file ─────────
function setLocalePreference(lang) {
  const text = readFileSync(SETTINGS_FILE, 'utf8')
  const lines = text.split(/\r?\n/)
  const idx = lines.findIndex((l) => /^locale\s*:/.test(l))
  if (idx >= 0) {
    let end = idx + 1
    while (end < lines.length && !/^\S/.test(lines[end]) && lines[end].trim() !== '') end++
    while (end < lines.length && lines[end].trim() === '') end++
    lines.splice(idx, end - idx, 'locale:', `  preference: ${lang}`)
  } else {
    lines.push('locale:', `  preference: ${lang}`)
  }
  writeFileSync(SETTINGS_FILE, lines.join('\n') + '\n')
}

// ── 1. forge a session cookie from the local web-auth secret ────────────────
function forgeCookie() {
  const authDir = process.env.DSH_WEB_AUTH_DIR || join(homedir(), '.dsh', 'web-auth')
  // readSecret() in dsh-web-auth reads the file as a RAW Buffer (no utf8/trim)
  const secret = readFileSync(join(authDir, 'secret'))
  if (secret.length < 32) throw new Error(`auth secret too short: ${secret.length} bytes`)
  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
  const payload = Buffer.from(JSON.stringify({ v: 1, exp })).toString('base64url')
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

// ── 2. launch headless chrome on an ephemeral debugging port ────────────────
async function launchChrome() {
  const profile = join('/tmp', `dsh-shot-${process.pid}`)
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=1680,1050',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' })
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100; i++) {
    try {
      const [port] = readFileSync(portFile, 'utf8').split('\n')
      return { chrome, port, profile }
    } catch { await sleep(100) }
  }
  throw new Error('Chrome did not open a debugging port')
}

// ── 3. minimal CDP client (Node ≥ 21 has a global WebSocket) ────────────────
async function connect(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.rej(new Error(`${m.error.message} (${m.error.data ?? ''})`)) : p.res(m.result)
    }
  }
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('page JS error: ' + r.exceptionDetails.text)
    return r.result?.value
  }
  const waitFor = async (expression, timeoutMs = 30000, label = expression) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try { if (await evaluate(expression)) return } catch {}
      await sleep(300)
    }
    throw new Error(`timeout waiting for: ${label}`)
  }
  const shot = async (file, clip) => {
    const params = { format: 'png', fromSurface: true }
    if (clip) params.clip = clip
    const { data } = await send('Page.captureScreenshot', params)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log('saved:', file)
  }
  return { ws, send, evaluate, waitFor, shot }
}

// click the first element whose trimmed text matches (exact or prefix)
async function clickText(cdp, text) {
  return cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
      const t = n.textContent.trim()
      if (t && (t === wanted || t.startsWith(wanted))) {
        let el = n.parentElement
        while (el && !['BUTTON', 'A', 'LI', 'LABEL', 'SPAN'].includes(el.tagName)) el = el.parentElement
        while (el && !el.onclick && el.tagName !== 'BUTTON' && el.tagName !== 'A') el = el.parentElement
        if (el) { el.click(); return { ok: true, tag: el.tagName, clicked: t.slice(0, 60) } }
      }
    }
    return { ok: false }
  })()`)
}

async function main() {
  const cookie = forgeCookie()
  const originalSettings = LOCALE !== undefined ? readFileSync(SETTINGS_FILE, 'utf8') : null
  if (LOCALE !== undefined) {
    setLocalePreference(LOCALE)
    console.log(`locale.preference -> ${LOCALE} (settings file updated)`)
    await sleep(800) // let the settings watcher reload
  }
  const { chrome, port, profile } = await launchChrome()
  const cdp = await connect(port)
  try {
    await cdp.send('Network.enable')
    await cdp.send('Page.enable')
    await cdp.send('Network.setCookie', {
      name: 'dsh_web_auth', value: cookie, url: BASE + '/',
    })
    await cdp.send('Page.navigate', { url: BASE + '/' })

    // wait for the SPA to boot (app shell has text)
    try {
      await cdp.waitFor(`document.body && document.body.innerText.trim().length > 120`, 40000, 'app boot')
    } catch (e) {
      const t = await cdp.evaluate('location.href + "\\n---\\n" + document.body.innerText')
      console.error('boot debug:\n', t.slice(0, 2000))
      throw e
    }

    if (MODE === 'explore') {
      const text = await cdp.evaluate('document.body.innerText')
      console.log('===== PAGE TEXT =====')
      console.log(text.slice(0, 6000))
      await cdp.shot('/tmp/dsh-shot-explore.png')
      console.log('full screenshot: /tmp/dsh-shot-explore.png')
      return
    }

    // navigate: sidebar 设置/Settings → 插件/Plugins → 插件配置/Plugin configuration
    const nav = NAV[LOCALE ?? 'zh']
    for (const label of nav) {
      const r = await clickText(cdp, label)
      if (!r.ok) {
        const text = await cdp.evaluate('document.body.innerText')
        throw new Error(`could not click "${label}"\n--- page text ---\n` + text.slice(0, 3000))
      }
      console.log(`clicked "${label}" -> ${r.clicked}`)
      await sleep(900)
    }

    // the card may already be collapsed; expand it and wait for its body to load
    await cdp.waitFor(`!!document.querySelector('.mp-card')`, 20000, '.mp-card')
    const headClicked = await cdp.evaluate(`(() => {
      const head = document.querySelector('.mp-card-head')
      if (!head) return false
      if (head.getAttribute('aria-expanded') !== 'true') head.click()
      return true
    })()`)
    console.log('card head expanded:', headClicked)
    await cdp.waitFor(`document.querySelector('.mp-card')?.getAttribute('data-open') !== undefined && !!document.querySelector('.mp-card-body .mp-button')`, 20000, 'card body loaded')
    await sleep(800)

    // print the rendered card text so the capture language can be verified
    const cardText = await cdp.evaluate(`document.querySelector('.mp-card').innerText`)
    console.log('===== CARD TEXT =====\n' + cardText)

    // strip the card's border/radius (they render as gray edge lines in the
    // shot) and hide the settings modal's full-screen scrim mask
    // (VOzbGW_mask, rgba(0,0,0,.24)): the mask is a fixed overlay that leaks
    // into full-page captures and dims the card region to ~194 gray.
    await cdp.evaluate(`(() => {
      const s = document.createElement('style')
      s.id = 'shot-fix'
      s.textContent = '.mp-card { border: 0 !important; border-radius: 0 !important; transition: none !important; } .mp-card-head { border-radius: 0 !important; } [class$="_mask"] { display: none !important; }'
      document.head.appendChild(s)
      return true
    })()`)
    await sleep(400)
    await cdp.evaluate(`document.querySelector('.mp-card').scrollIntoView({ block: 'center' })`)
    await sleep(500)

    // document-space rect — scroll-independent
    const docRect = await cdp.evaluate(`(() => {
      const r = document.querySelector('.mp-card').getBoundingClientRect()
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height }
    })()`)
    console.log('card docRect:', JSON.stringify(docRect))

    // sanity: the element at the card's top-left must be the card, not a mask
    const topEl = await cdp.evaluate(`(() => {
      const r = document.querySelector('.mp-card').getBoundingClientRect()
      const el = document.elementFromPoint(r.x + 8, r.y + 8)
      return el ? el.className.toString().slice(0, 60) || el.tagName : 'null'
    })()`)
    console.log('element at card top-left:', topEl)

    // full-page 2× capture (no clip → immune to viewport scroll races).
    // The settings modal is position:fixed and can overflow the outer page
    // height (cssContentSize), so extend the clip to cover the card's bottom.
    const layout = await cdp.send('Page.getLayoutMetrics')
    const css = layout.cssContentSize
    const shotW = Math.max(css.width, Math.ceil(docRect.x + docRect.w) + 100)
    const shotH = Math.max(css.height, Math.ceil(docRect.y + docRect.h) + 100)
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: shotW, height: shotH, scale: 2 },
    })

    // crop to the card rect in-page (canvas does the PNG re-encode)
    const cropped = await cdp.evaluate(`(async (b64, rect) => {
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64 })
      const x = Math.max(0, Math.round(rect.x * 2)), y = Math.max(0, Math.round(rect.y * 2))
      const w = Math.round(rect.w * 2), h = Math.round(rect.h * 2)
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const g = c.getContext('2d')
      g.imageSmoothingEnabled = false
      g.drawImage(img, x, y, w, h, 0, 0, w, h)
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
      const buf = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
      return btoa(bin)
    })(${JSON.stringify(data)}, ${JSON.stringify(docRect)})`)

    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, Buffer.from(cropped, 'base64'))
    console.log('saved:', OUT)
  } finally {
    cdp.ws.close()
    chrome.kill('SIGKILL')
    if (originalSettings !== null) {
      writeFileSync(SETTINGS_FILE, originalSettings)
      console.log('settings.yaml restored')
    }
  }
}

main().catch((err) => {
  console.error('capture failed:', err.message)
  process.exit(1)
})
