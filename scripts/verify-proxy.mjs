/**
 * Standalone verification of the system-proxy support used by the catalog
 * download: OS probe parsers, bypass matching, route selection, the CONNECT
 * tunnel transport, and how the catalog manager records the route / error.
 *
 * Run after a build:
 *   pnpm build && node scripts/verify-proxy.mjs
 *
 * The end-to-end tunnel check needs `openssl` to mint a throwaway certificate;
 * when it is missing those cases are reported as skipped and the rest still run.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CatalogManager,
  detectSystemProxy,
  fetchJsonViaProxy,
  fetchJsonWithSystemProxy,
  maskProxyUrl,
  parseRegistryQuery,
  parseScutilProxyOutput,
  resolveCatalogRoute,
  shouldBypassProxy,
  transportOf,
  windowsProxyFromRegistry,
} from '../lib/index.js'

const silent = { info() {}, warn() {} }
const scratch = mkdtempSync(join(tmpdir(), 'dsh-mp-proxy-'))
let failures = 0
let passes = 0
let skips = 0

function check(name, fn) {
  try {
    fn()
    passes++
    console.log(`✓ ${name}`)
  } catch (error) {
    failures++
    console.log(`✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passes++
    console.log(`✓ ${name}`)
  } catch (error) {
    failures++
    console.log(`✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`)
  }
}

function skip(name, reason) {
  skips++
  console.log(`○ ${name} (skipped: ${reason})`)
}

/** No ambient proxy may leak into route tests. */
for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) {
  delete process.env[name]
}

// ── OS probe parsers ─────────────────────────────────────────────────────────

const scutilManual = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}
`

const scutilPac = `<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://wpad.example/wpad.dat
  HTTPEnable : 0
  HTTPSEnable : 0
}
`

check('macOS: manual HTTP/HTTPS proxy + exceptions', () => {
  const parsed = parseScutilProxyOutput(scutilManual)
  assert.equal(parsed?.source, 'macos')
  assert.equal(parsed?.http, 'http://127.0.0.1:7890')
  assert.equal(parsed?.https, 'http://127.0.0.1:7890')
  assert.equal(parsed?.noProxy, '*.local,169.254/16')
  assert.deepEqual(parsed?.diagnostics, [])
})

check('macOS: PAC-only configuration is reported, not silently proxied', () => {
  const parsed = parseScutilProxyOutput(scutilPac)
  assert.equal(parsed?.http, undefined)
  assert.equal(parsed?.https, undefined)
  assert.ok(parsed?.diagnostics.some((line) => line.includes('PAC')))
})

const regServer = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    AutoConfigURL    REG_SZ
    ProxyEnable    REG_DWORD    0x1
    ProxyOverride    REG_SZ    localhost;127.*;10.*;*.corp.example;<local>
    ProxyServer    REG_SZ    127.0.0.1:7890
    DefaultConnectionSettings    REG_BINARY    01000000000000000000000000000000
`

const regPerScheme = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080
`

check('Windows: single proxy applies to both schemes, override list normalized', () => {
  const values = parseRegistryQuery(regServer)
  assert.equal(values.get('ProxyEnable'), '1')
  assert.equal(values.get('ProxyServer'), '127.0.0.1:7890')
  const parsed = windowsProxyFromRegistry(values)
  assert.equal(parsed?.source, 'windows')
  assert.equal(parsed?.http, 'http://127.0.0.1:7890')
  assert.equal(parsed?.https, 'http://127.0.0.1:7890')
  assert.equal(parsed?.noProxy, 'localhost,127.*,10.*,*.corp.example,<local>')
  assert.deepEqual(parsed?.diagnostics, [])
})

check('Windows: per-scheme entries are honored, SOCKS is reported', () => {
  const parsed = windowsProxyFromRegistry(parseRegistryQuery(regPerScheme))
  assert.equal(parsed?.http, 'http://127.0.0.1:7890')
  assert.equal(parsed?.https, 'http://127.0.0.1:7891')
  assert.ok(parsed?.diagnostics.some((line) => line.includes('SOCKS')))
})

check('Windows: disabled proxy and no PAC reads as no configuration', () => {
  const values = parseRegistryQuery(`    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890\n`)
  assert.equal(windowsProxyFromRegistry(values), undefined)
})

// ── bypass matching ──────────────────────────────────────────────────────────

check('bypass: suffix, wildcard, port, <local>, loopback and *', () => {
  assert.equal(shouldBypassProxy('example.com', new URL('https://api.example.com/x')), true)
  assert.equal(shouldBypassProxy('10.*', new URL('http://10.1.2.3/x')), true)
  assert.equal(shouldBypassProxy('<local>', new URL('http://intranet/x')), true)
  assert.equal(shouldBypassProxy('<local>', new URL('http://intranet.corp/x')), false)
  assert.equal(shouldBypassProxy('models.dev:443', new URL('https://models.dev/api.json')), true)
  assert.equal(shouldBypassProxy('models.dev:8443', new URL('https://models.dev/api.json')), false)
  assert.equal(shouldBypassProxy('*.local', new URL('https://api.local/x')), true)
  assert.equal(shouldBypassProxy('', new URL('http://127.0.0.1:8080/x')), true)
  assert.equal(shouldBypassProxy('', new URL('https://models.dev/api.json')), false)
  assert.equal(shouldBypassProxy('*', new URL('https://models.dev/api.json')), true)
})

// ── route selection ──────────────────────────────────────────────────────────

const winRun = async () => regServer
const macRun = async () => scutilManual
const pacRun = async () => scutilPac
const failingRun = async () => {
  throw new Error('probe unavailable')
}

await checkAsync('route: env proxy defers to the harness (no OS probe)', async () => {
  let probed = false
  const route = await resolveCatalogRoute('https://models.dev/api.json', {
    env: { HTTPS_PROXY: 'http://127.0.0.1:9999' },
    platform: 'linux',
    run: async () => {
      probed = true
      return ''
    },
  })
  assert.equal(route.source, 'env')
  assert.equal(route.tunnel, false)
  assert.equal(probed, false)
  assert.deepEqual(transportOf(route), { kind: 'env' })
})

await checkAsync('route: blank env value does not count as a proxy', async () => {
  const route = await resolveCatalogRoute('https://models.dev/api.json', {
    env: { HTTPS_PROXY: '   ' },
    platform: 'linux',
  })
  assert.equal(route.source, 'none')
  assert.equal(route.tunnel, false)
})

await checkAsync('route: Windows registry proxy is tunneled', async () => {
  const route = await resolveCatalogRoute('https://models.dev/api.json', { env: {}, platform: 'win32', run: winRun })
  assert.equal(route.source, 'windows')
  assert.equal(route.tunnel, true)
  assert.equal(route.proxy, 'http://127.0.0.1:7890')
  assert.deepEqual(transportOf(route), { kind: 'windows', proxy: 'http://127.0.0.1:7890' })
})

await checkAsync('route: macOS manual proxy is tunneled', async () => {
  const route = await resolveCatalogRoute('https://models.dev/api.json', { env: {}, platform: 'darwin', run: macRun })
  assert.equal(route.source, 'macos')
  assert.equal(route.tunnel, true)
  assert.equal(route.proxy, 'http://127.0.0.1:7890')
})

await checkAsync('route: a scheme without its own OS proxy stays direct and says why', async () => {
  const run = async () => `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
}
`
  const route = await resolveCatalogRoute('https://models.dev/api.json', { env: {}, platform: 'darwin', run })
  assert.equal(route.tunnel, false)
  assert.ok(route.diagnostics.some((line) => line.includes('no HTTPS proxy')))
})

await checkAsync('route: loopback target bypasses the detected proxy', async () => {
  const route = await resolveCatalogRoute('http://127.0.0.1:8080/api.json', { env: {}, platform: 'win32', run: winRun })
  assert.equal(route.tunnel, false)
  assert.equal(route.source, 'windows')
})

await checkAsync('route: OS bypass list exempts models.dev', async () => {
  const run = async () => regServer.replace('ProxyOverride    REG_SZ    localhost;127.*;10.*;*.corp.example;<local>', 'ProxyOverride    REG_SZ    models.dev')
  const route = await resolveCatalogRoute('https://models.dev/api.json', { env: {}, platform: 'win32', run })
  assert.equal(route.tunnel, false)
})

await checkAsync('route: PAC-only stays direct and reports why', async () => {
  const route = await resolveCatalogRoute('https://models.dev/api.json', { env: {}, platform: 'darwin', run: pacRun })
  assert.equal(route.tunnel, false)
  assert.ok(route.diagnostics.length > 0)
})

await checkAsync('route: failing probe falls back to direct', async () => {
  const route = await resolveCatalogRoute('https://models.dev/api.json', { env: {}, platform: 'win32', run: failingRun })
  assert.equal(route.source, 'none')
  assert.equal(route.tunnel, false)
})

await checkAsync('route: Linux reads no OS proxy', async () => {
  const route = await resolveCatalogRoute('https://models.dev/api.json', { env: {}, platform: 'linux' })
  assert.equal(route.source, 'none')
})

await checkAsync('detectSystemProxy: returns raw OS configuration', async () => {
  const config = await detectSystemProxy({ platform: 'win32', env: {}, run: winRun })
  assert.equal(config?.source, 'windows')
  assert.equal(config?.https, 'http://127.0.0.1:7890')
})

check('credentials are stripped from the displayed proxy', () => {
  assert.equal(maskProxyUrl('http://user:secret@127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(maskProxyUrl('not a url'), undefined)
  const route = { tunnel: true, proxy: 'http://user:secret@127.0.0.1:7890', source: 'windows', noProxy: '', diagnostics: [] }
  assert.deepEqual(transportOf(route), { kind: 'windows', proxy: 'http://127.0.0.1:7890' })
})

// ── transport over a real CONNECT tunnel ─────────────────────────────────────

let certificate = null
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(scratch, 'key.pem'),
    '-out', join(scratch, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' })
  certificate = { key: readFileSync(join(scratch, 'key.pem')), cert: readFileSync(join(scratch, 'cert.pem')) }
} catch {
  certificate = null
}

/** A loopback CONNECT proxy that logs and tunnels everything it accepts. */
async function startProxy({ refuse = false, requireAuth = false } = {}) {
  const seen = []
  const server = http.createServer((request, response) => {
    response.writeHead(501)
    response.end('CONNECT only')
  })
  server.on('connect', (request, clientSocket, head) => {
    const auth = request.headers['proxy-authorization']
    seen.push({ target: request.url, auth })
    if (refuse || (requireAuth && typeof auth !== 'string')) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const [host, port] = request.url.split(':')
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, seen }
}

async function runTransportChecks() {
  if (certificate === null) {
    skips += 4
    console.log('○ CONNECT tunnel: JSON download, redirect, refused CONNECT, proxy auth (skipped: openssl unavailable)')
    return
  }
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  const requests = []
  const target = https.createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
    requests.push(request.url)
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/api.json' })
      response.end()
      return
    }
    if (request.url === '/missing') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('nope')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ provider: { models: { 'm-1': { name: 'M1' } } } }))
  })
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
  const targetUrl = `https://localhost:${target.address().port}`

  const proxy = await startProxy()
  try {
    await checkAsync('tunnel: JSON download through CONNECT', async () => {
      const body = await fetchJsonViaProxy(`${targetUrl}/api.json`, `http://127.0.0.1:${proxy.port}`, 5_000)
      assert.deepEqual(body, { provider: { models: { 'm-1': { name: 'M1' } } } })
      assert.ok(proxy.seen.some((entry) => entry.target === `localhost:${target.address().port}`))
    })

    await checkAsync('tunnel: redirects are followed inside the tunnel', async () => {
      const before = proxy.seen.length
      const body = await fetchJsonViaProxy(`${targetUrl}/redirect`, `http://127.0.0.1:${proxy.port}`, 5_000)
      assert.ok(body.provider)
      assert.deepEqual(requests.slice(-2), ['/redirect', '/api.json'])
      assert.equal(proxy.seen.length - before, 2)
    })

    await checkAsync('tunnel: non-2xx answers throw, keeping the cache path intact', async () => {
      await assert.rejects(
        () => fetchJsonViaProxy(`${targetUrl}/missing`, `http://127.0.0.1:${proxy.port}`, 5_000),
        /HTTP 404/,
      )
    })

    const authProxy = await startProxy({ requireAuth: true })
    try {
      await checkAsync('tunnel: proxy Basic credentials from the proxy URL', async () => {
        const body = await fetchJsonViaProxy(
          `${targetUrl}/api.json`,
          `http://user:secret@127.0.0.1:${authProxy.port}`,
          5_000,
        )
        assert.ok(body.provider)
        assert.equal(authProxy.seen[0].auth, `Basic ${Buffer.from('user:secret').toString('base64')}`)
      })
    } finally {
      authProxy.server.close()
    }

    const refusing = await startProxy({ refuse: true })
    try {
      await checkAsync('tunnel: refused CONNECT surfaces a proxy error', async () => {
        await assert.rejects(
          () => fetchJsonViaProxy(`${targetUrl}/api.json`, `http://127.0.0.1:${refusing.port}`, 5_000),
          /refused CONNECT with HTTP 403/,
        )
      })
    } finally {
      refusing.server.close()
    }

    await checkAsync('direct: loopback fetch still works with detection pinned off', async () => {
      const result = await fetchJsonWithSystemProxy(`${targetUrl}/api.json`, 5_000, silent, { env: {}, platform: 'linux' })
      assert.deepEqual(result.transport, { kind: 'direct' })
      assert.ok(result.body.provider)
    })

    await checkAsync('failure: the attempted route rides the error', async () => {
      await assert.rejects(
        () => fetchJsonWithSystemProxy('https://127.0.0.1:1/api.json', 2_000, silent, {
          env: { HTTPS_PROXY: 'http://127.0.0.1:9999' },
          platform: 'linux',
        }),
        (error) => {
          assert.equal(error.transport?.kind, 'env')
          assert.ok(error.message.length > 0)
          return true
        },
      )
    })

    await checkAsync('route + tunnel: injected macOS proxy points the catalog at the tunnel', async () => {
      const scutil = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : ${proxy.port}
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : ${proxy.port}
  HTTPSProxy : 127.0.0.1
}
`
      const route = await resolveCatalogRoute('https://models.dev/api.json', {
        env: {},
        platform: 'darwin',
        run: async () => scutil,
      })
      assert.equal(route.tunnel, true)
      assert.equal(route.proxy, `http://127.0.0.1:${proxy.port}`)
      const body = await fetchJsonViaProxy(`${targetUrl}/api.json`, route.proxy, 5_000)
      assert.ok(body.provider)
    })
  } finally {
    proxy.server.close()
    target.close()
  }
}

await runTransportChecks()

// ── catalog manager: route, cache, error reporting ───────────────────────────

const catalogBody = {
  acme: { models: { 'acme-1': { name: 'Acme 1', limit: { context: 200000, output: 8192 } } } },
}

await checkAsync('catalog: successful download records the route', async () => {
  const dir = mkdtempSync(join(scratch, 'catalog-ok-'))
  let calls = 0
  const manager = new CatalogManager(silent, dir, async (url, timeoutMs) => {
    calls++
    assert.ok(timeoutMs > 0)
    return { body: catalogBody, transport: { kind: 'windows', proxy: 'http://127.0.0.1:7890' } }
  })
  await manager.ensureFresh({ ttlDays: 7 }, true)
  assert.equal(calls, 1)
  const snapshot = manager.snapshotOf()
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.entries[0].context, 200000)
  assert.deepEqual(snapshot.transport, { kind: 'windows', proxy: 'http://127.0.0.1:7890' })
  assert.equal(snapshot.error, undefined)

  // Second manager over the same directory reads the cache without fetching.
  let cachedCalls = 0
  const cached = new CatalogManager(silent, dir, async () => {
    cachedCalls++
    throw new Error('must not fetch a fresh cache')
  })
  await cached.ensureFresh({ ttlDays: 7 })
  assert.equal(cachedCalls, 0)
  assert.equal(cached.snapshotOf().entries.length, 1)
})

await checkAsync('catalog: a failed download records the attempted route', async () => {
  const dir = mkdtempSync(join(scratch, 'catalog-route-'))
  const manager = new CatalogManager(silent, dir, async () => {
    const error = new Error('proxy 127.0.0.1 refused CONNECT with HTTP 407')
    error.transport = { kind: 'windows', proxy: 'http://127.0.0.1:7890' }
    throw error
  })
  await manager.ensureFresh({ ttlDays: 7 }, true)
  const snapshot = manager.snapshotOf()
  assert.equal(snapshot.entries.length, 0)
  assert.match(snapshot.error ?? '', /407/)
  assert.deepEqual(snapshot.transport, { kind: 'windows', proxy: 'http://127.0.0.1:7890' })
})

await checkAsync('catalog: failed download keeps the cache and records the error', async () => {
  const dir = mkdtempSync(join(scratch, 'catalog-fail-'))
  const manager = new CatalogManager(silent, dir, async () => ({
    body: catalogBody,
    transport: { kind: 'direct' },
  }))
  await manager.ensureFresh({ ttlDays: 7 }, true)

  const failing = new CatalogManager(silent, dir, async () => {
    throw new Error('proxy 127.0.0.1 refused CONNECT with HTTP 407')
  })
  await failing.ensureFresh({ ttlDays: 7 }, true)
  const snapshot = failing.snapshotOf()
  assert.equal(snapshot.entries.length, 1)
  assert.match(snapshot.error ?? '', /refused CONNECT with HTTP 407/)
})

// ── summary ──────────────────────────────────────────────────────────────────

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${passes} passed, ${failures} failed${skips > 0 ? `, ${skips} skipped` : ''}`)
process.exit(failures > 0 ? 1 : 0)
