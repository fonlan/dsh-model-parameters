/**
 * System-proxy discovery and transport for the models.dev catalog download.
 *
 * The harness already routes plain `fetch()` through undici's global
 * dispatcher, which resolves `http_proxy` / `https_proxy` / `all_proxy` from
 * the launch environment (`@deepseek-ai/dsh-http-proxy`). That dispatcher
 * deliberately does NOT read the operating system's proxy configuration, so on
 * a machine where the user only enabled a proxy in Windows Internet Settings or
 * macOS Network settings the catalog download went direct and failed behind the
 * proxy.
 *
 * This module supplies the missing half:
 *   1. when the environment names a proxy, defer to the harness so the existing
 *      routing (including its diagnostics and loopback bypass) is unchanged;
 *   2. otherwise read the OS proxy — Windows registry `Internet Settings`,
 *      macOS `scutil --proxy` — and tunnel the download through it with Node's
 *      own https stack (CONNECT, proxy Basic auth, redirects);
 *   3. otherwise download directly.
 *
 * Deliberate limits: SOCKS proxies and PAC scripts are never evaluated (a
 * PAC-only configuration is reported and the download stays direct — set
 * `HTTP_PROXY`/`HTTPS_PROXY` instead); a bypass entry in CIDR form
 * (`10.0.0.0/8`) is not matched; proxy credentials stored in the OS credential
 * manager are not sent.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request as httpRequest, type AgentOptions, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import { isIP, type Socket } from 'node:net'
import { join } from 'node:path'
import { connect as connectTls, type ConnectionOptions, TLSSocket } from 'node:tls'
import type { Duplex } from 'node:stream'

/** Structural logger subset satisfied by cordis' LoggerService. */
export interface ProxyLogger {
  info(format: any, ...param: any[]): void
  warn(format: any, ...param: any[]): void
}

/** Where a detected proxy configuration came from. */
export type ProxySource = 'env' | 'windows' | 'macos' | 'none'

/** One proxy configuration read from the operating system. */
export interface SystemProxyConfig {
  /** Proxy URL for `http:` targets. */
  http?: string
  /** Proxy URL for `https:` targets. */
  https?: string
  /** The OS bypass/exceptions list, comma separated. */
  noProxy?: string
  source: 'windows' | 'macos'
  /** Notes about settings this module cannot honor (PAC, SOCKS, malformed entries). */
  diagnostics: string[]
}

/** What the catalog download will do for one URL. */
export interface CatalogRoute {
  /** True when this plugin must tunnel the request itself. */
  tunnel: boolean
  /** Proxy URL, present only when {@link CatalogRoute.tunnel} is true. */
  proxy?: string
  source: ProxySource
  /** Effective bypass list (OS exceptions; loopback is always bypassed). */
  noProxy: string
  diagnostics: string[]
}

/** Structured routing outcome, safe to cross the settings API (credentials stripped). */
export interface CatalogTransport {
  kind: 'direct' | 'env' | 'macos' | 'windows'
  /** Masked proxy URL (no credentials), when a proxy is actually used. */
  proxy?: string
}

/** A downloaded and parsed catalog document plus the route it took. */
export interface CatalogFetchResult {
  body: unknown
  transport: CatalogTransport
}

/** Download one JSON document; {@link CatalogManager} takes one for tests. */
export type CatalogFetch = (url: string, timeoutMs: number) => Promise<CatalogFetchResult>

/** Runs one detection command; injectable so the OS parsers stay testable. */
export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>

/** Detection inputs; every field exists so tests can pin a platform and its probes. */
export interface DetectOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  run?: CommandRunner
  timeoutMs?: number
}

const PROXY_ENV_NAMES = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'all_proxy',
  'ALL_PROXY',
] as const

/** Per-user Internet Settings key WinINET (and every proxy app that toggles "system proxy") writes. */
const WINDOWS_INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** How long one detection probe may take. */
const DETECT_TIMEOUT_MS = 5_000

/** Redirect statuses a download follows. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const MAX_REDIRECTS = 4

// ── environment ──────────────────────────────────────────────────────────────

/** The first proxy environment variable that carries a value, if any. */
function proxyEnvironmentName(env: NodeJS.ProcessEnv): string | undefined {
  return PROXY_ENV_NAMES.find((name) => (env[name] ?? '').trim() !== '')
}

// ── OS probes ────────────────────────────────────────────────────────────────

const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr.trim() === '' ? error.message : stderr.trim()}`))
        return
      }
      resolve(stdout)
    })
  })

/**
 * Parse the value table `reg query <key>` prints. Value names and the
 * `REG_*` type tokens are not localized, so the same table parses under every
 * Windows display language. Binary values (the `DefaultConnectionSettings`
 * blob) are read as empty — nothing in this module consumes them.
 */
export function parseRegistryQuery(output: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s{2,}(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/.exec(line)
    if (match === null) continue
    const [, name, type, raw] = match
    if (type === 'REG_BINARY') {
      values.set(name, '')
      continue
    }
    values.set(name, type === 'REG_DWORD' ? String(Number.parseInt(raw.trim(), 16) || 0) : raw.trim())
  }
  return values
}

/**
 * Turn the Internet Settings values into a proxy configuration.
 * `ProxyServer` is either `host:port` (both schemes) or a
 * `http=host:port;https=host:port` list.
 * @returns the configuration, or undefined when the OS names no proxy at all.
 */
export function windowsProxyFromRegistry(values: Map<string, string>): SystemProxyConfig | undefined {
  const enabled = (values.get('ProxyEnable') ?? '0') !== '0'
  const server = (values.get('ProxyServer') ?? '').trim()
  const override = windowsBypassList(values.get('ProxyOverride') ?? '')
  const autoConfig = (values.get('AutoConfigURL') ?? '').trim()
  const diagnostics: string[] = []
  const config: SystemProxyConfig = { source: 'windows', noProxy: override, diagnostics }

  if (enabled && server !== '') {
    if (server.includes('=')) {
      for (const entry of server.split(';')) {
        const separator = entry.indexOf('=')
        if (separator === -1) continue
        const scheme = entry.slice(0, separator).trim().toLowerCase()
        const hostPort = entry.slice(separator + 1).trim()
        if (hostPort === '') continue
        if (scheme !== 'http' && scheme !== 'https') {
          if (scheme === 'socks') {
            diagnostics.push('Windows names a SOCKS proxy, which is not supported; the catalog download stays direct')
          }
          continue
        }
        const url = proxyUrlFromHostPort(hostPort)
        if (url === undefined) {
          diagnostics.push(`Windows proxy entry "${scheme}=${hostPort}" is not a usable proxy URL; ignored`)
          continue
        }
        if (scheme === 'http') config.http = url
        else config.https = url
      }
    } else {
      const url = proxyUrlFromHostPort(server)
      if (url === undefined) {
        diagnostics.push(`Windows proxy server "${server}" is not a usable proxy URL; the catalog download stays direct`)
      } else {
        config.http = url
        config.https = url
      }
    }
  }

  if (autoConfig !== '') {
    diagnostics.push('Windows uses an automatic proxy configuration (PAC) script, which is not evaluated; set HTTP_PROXY/HTTPS_PROXY to route the catalog download')
  }

  const configured = config.http !== undefined || config.https !== undefined
  return configured || diagnostics.length > 0 ? config : undefined
}

/** `ProxyOverride` is `;`-separated and may carry `<local>`; our matcher consumes both forms. */
function windowsBypassList(override: string): string {
  return override
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .join(',')
}

/** macOS `scutil --proxy` prints a flat key/value dictionary with nested arrays. */
export function parseScutilProxyOutput(output: string): SystemProxyConfig | undefined {
  const values = new Map<string, string>()
  const exceptions: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([^:<]+?)\s*:\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    const key = match[1].trim()
    const value = match[2].trim()
    // Array elements print as `0 : *.local`; every top-level key is a name.
    if (/^\d+$/.test(key)) {
      exceptions.push(value)
      continue
    }
    values.set(key, value)
  }

  const flag = (key: string): boolean => values.get(key) === '1' || values.get(key) === 'true'
  const port = (key: string, fallback: number): string => {
    const value = values.get(key)
    return value !== undefined && /^\d+$/.test(value) ? value : String(fallback)
  }
  const diagnostics: string[] = []
  const config: SystemProxyConfig = { source: 'macos', noProxy: exceptions.join(','), diagnostics }

  const httpHost = values.get('HTTPProxy')
  if (flag('HTTPEnable') && httpHost !== undefined && httpHost !== '') {
    config.http = `${/^https?:\/\//.test(httpHost) ? '' : 'http://'}${httpHost}:${port('HTTPPort', 80)}`
  }
  const httpsHost = values.get('HTTPSProxy')
  if (flag('HTTPSEnable') && httpsHost !== undefined && httpsHost !== '') {
    config.https = `${/^https?:\/\//.test(httpsHost) ? '' : 'http://'}${httpsHost}:${port('HTTPSPort', 443)}`
  }

  if (flag('ProxyAutoConfigEnable')) {
    diagnostics.push('macOS uses an automatic proxy configuration (PAC) file, which is not evaluated; set HTTP_PROXY/HTTPS_PROXY to route the catalog download')
  }
  if (flag('ProxyAutoDiscoveryEnable')) {
    diagnostics.push('macOS runs automatic proxy discovery (WPAD), which is not evaluated; set HTTP_PROXY/HTTPS_PROXY to route the catalog download')
  }
  if (flag('SOCKSEnable')) {
    diagnostics.push('macOS names a SOCKS proxy, which is not supported; the catalog download stays direct for that route')
  }

  const configured = config.http !== undefined || config.https !== undefined
  return configured || diagnostics.length > 0 ? config : undefined
}

async function detectWindowsProxy(run: CommandRunner, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<SystemProxyConfig | undefined> {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT
  const executable = systemRoot !== undefined && existsSync(join(systemRoot, 'System32', 'reg.exe'))
    ? join(systemRoot, 'System32', 'reg.exe')
    : 'reg'
  let output: string
  try {
    output = await run(executable, ['query', WINDOWS_INTERNET_SETTINGS], timeoutMs)
  } catch {
    return undefined
  }
  return windowsProxyFromRegistry(parseRegistryQuery(output))
}

async function detectMacProxy(run: CommandRunner, timeoutMs: number): Promise<SystemProxyConfig | undefined> {
  let output: string
  try {
    output = await run('scutil', ['--proxy'], timeoutMs)
  } catch {
    return undefined
  }
  return parseScutilProxyOutput(output)
}

/**
 * Read the operating system's proxy configuration (never the environment).
 * Linux has no portable API for this; its users configure the environment,
 * which the harness routes.
 * @param options - platform, probe runner and timeout (tests pin all three).
 * @returns the detected configuration, or undefined when the OS names none.
 */
export async function detectSystemProxy(options: DetectOptions = {}): Promise<SystemProxyConfig | undefined> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const run = options.run ?? runCommand
  const timeoutMs = options.timeoutMs ?? DETECT_TIMEOUT_MS
  if (platform === 'win32') return detectWindowsProxy(run, env, timeoutMs)
  if (platform === 'darwin') return detectMacProxy(run, timeoutMs)
  return undefined
}

// ── bypass matching ──────────────────────────────────────────────────────────

/** A host this machine owns: a proxy cannot reach it, so it always goes direct. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** Split `host:port`, `[::1]:port` or a bare IPv6 literal without reading `::1` as host `:port`. */
function splitHostPort(entry: string): { host: string; port?: string } {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close !== -1) {
      const rest = entry.slice(close + 1)
      const host = entry.slice(1, close)
      return rest.startsWith(':') ? { host, port: rest.slice(1) } : { host }
    }
  }
  const colon = entry.indexOf(':')
  if (colon !== -1 && entry.indexOf(':', colon + 1) === -1) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) }
  }
  return { host: entry }
}

/** `*` / `?` entries appear in OS bypass lists (`10.*`, `*.corp`); CIDR does not. */
function globMatch(pattern: string, host: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${source}$`).test(host)
}

/**
 * Decide whether a bypass list exempts one URL. Semantics follow the harness's
 * own matcher — an entry covers its subdomains, a leading `.`/`*.` means the
 * same, an entry may carry a `:port`, `*` bypasses everything — plus the two
 * forms OS lists add: `host*` wildcards and `<local>` (a dotless hostname).
 * Loopback is always bypassed. CIDR notation is not matched.
 */
export function shouldBypassProxy(noProxy: string, url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (isLoopbackHost(host)) return true
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  for (const raw of noProxy.split(/[,\s;]+/)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    if (entry === '<local>') {
      if (!host.includes('.')) return true
      continue
    }
    const split = splitHostPort(entry)
    if (split.port !== undefined && split.port !== port) continue
    const candidate = split.host.replace(/^\*?\./, '').replace(/\.$/, '')
    if (candidate === '') continue
    if (candidate.includes('*') || candidate.includes('?')) {
      if (globMatch(candidate, host)) return true
      continue
    }
    if (host === candidate || host.endsWith(`.${candidate}`)) return true
  }
  return false
}

// ── route resolution ─────────────────────────────────────────────────────────

/**
 * Decide how the catalog download for `target` is routed: defer to the harness
 * for environment proxies, tunnel a detected OS proxy, or go direct. The OS is
 * consulted only when the environment names no proxy, so an exported variable
 * keeps winning exactly as it does for the rest of the harness.
 */
export async function resolveCatalogRoute(target: URL | string, options: DetectOptions = {}): Promise<CatalogRoute> {
  const url = typeof target === 'string' ? new URL(target) : target
  const env = options.env ?? process.env
  if (proxyEnvironmentName(env) !== undefined) {
    return {
      tunnel: false,
      source: 'env',
      noProxy: (env.no_proxy ?? env.NO_PROXY ?? '').trim(),
      diagnostics: [],
    }
  }
  const detected = await detectSystemProxy(options)
  if (detected === undefined) {
    return { tunnel: false, source: 'none', noProxy: '', diagnostics: [] }
  }
  const noProxy = detected.noProxy ?? ''
  // The OS configures HTTP and HTTPS proxies separately; honoring one for the
  // other would send a scheme through a proxy the user did not pick.
  const proxy = url.protocol === 'https:' ? detected.https : detected.http
  const diagnostics = [...detected.diagnostics]
  if (proxy === undefined) {
    const other = url.protocol === 'https:' ? detected.http : detected.https
    if (other !== undefined) {
      const missing = url.protocol === 'https:' ? 'HTTPS' : 'HTTP'
      const present = url.protocol === 'https:' ? 'HTTP' : 'HTTPS'
      diagnostics.push(`${detected.source === 'windows' ? 'Windows' : 'macOS'} configures an ${present} proxy but no ${missing} proxy; the catalog download connects directly`)
    }
    return { tunnel: false, source: detected.source, noProxy, diagnostics }
  }
  if (shouldBypassProxy(noProxy, url)) {
    return { tunnel: false, source: detected.source, noProxy, diagnostics }
  }
  return { tunnel: true, proxy, source: detected.source, noProxy, diagnostics }
}

/** Strip any proxy credentials before the route crosses the settings API or logs. */
export function maskProxyUrl(proxy: string): string | undefined {
  try {
    const url = new URL(proxy)
    url.username = ''
    url.password = ''
    return `${url.protocol}//${url.host}`
  } catch {
    return undefined
  }
}

/** Describe a route for the settings page. */
export function transportOf(route: CatalogRoute): CatalogTransport {
  if (route.tunnel && route.proxy !== undefined) {
    const kind = route.source === 'windows' ? 'windows' : route.source === 'macos' ? 'macos' : 'env'
    return { kind, proxy: maskProxyUrl(route.proxy) }
  }
  if (route.source === 'env') return { kind: 'env' }
  return { kind: 'direct' }
}

function describeTransport(transport: CatalogTransport): string {
  switch (transport.kind) {
    case 'env':
      return 'environment proxy variables (routed by the harness)'
    case 'windows':
      return `Windows system proxy ${transport.proxy ?? ''}`.trim()
    case 'macos':
      return `macOS system proxy ${transport.proxy ?? ''}`.trim()
    default:
      return 'direct (no system proxy)'
  }
}

// ── transport ────────────────────────────────────────────────────────────────

function proxyUrlFromHostPort(value: string): string | undefined {
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.hostname === '') return undefined
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return undefined
  }
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error && cause.message !== '' && !error.message.includes(cause.message)) {
    return `${error.message}: ${cause.message}`
  }
  return error.message
}

async function fetchJsonDirect(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    return (await response.json()) as unknown
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`catalog download timed out after ${timeoutMs}ms`)
    throw new Error(errorMessage(error))
  } finally {
    clearTimeout(timer)
  }
}

/** A URL hostname without the brackets WHATWG puts around IPv6 literals. */
function bareHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '')
}

/** Open a CONNECT tunnel to `host:port` through the proxy, authenticating when the URL carries credentials. */
function openProxyTunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<Socket> {
  const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`
  const headers: Record<string, string> = { host: authority }
  if (proxy.username !== '' || proxy.password !== '') {
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
    headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`
  }
  const secureProxy = proxy.protocol === 'https:'
  const request = (secureProxy ? httpsRequest : httpRequest) as typeof httpRequest
  const connectRequest = request({
    host: bareHostname(proxy.hostname),
    port: Number(proxy.port) || (secureProxy ? 443 : 80),
    method: 'CONNECT',
    path: authority,
    headers,
    agent: false,
    timeout: timeoutMs,
  })
  return new Promise<Socket>((resolve, reject) => {
    connectRequest.once('connect', (response: IncomingMessage, socket: Socket, head: Buffer) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy ${bareHostname(proxy.hostname)} refused CONNECT with HTTP ${response.statusCode ?? 0}`))
        return
      }
      if (head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    connectRequest.once('timeout', () => {
      connectRequest.destroy(new Error(`proxy CONNECT timed out after ${timeoutMs}ms`))
    })
    connectRequest.once('error', (error) => reject(error))
    connectRequest.end()
  })
}

/** An https agent whose every socket is a TLS session opened inside a proxy tunnel. */
class ProxyTunnelAgent extends HttpsAgent {
  constructor(
    private readonly proxy: URL,
    private readonly timeoutMs: number,
  ) {
    super({ keepAlive: false, maxSockets: 1 })
  }

  override createConnection(options: AgentOptions, callback?: (error: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    const host = typeof options.host === 'string' ? options.host : ''
    const port = Number(options.port ?? 443)
    const servername = (options as ConnectionOptions).servername
    this.open(host, port, typeof servername === 'string' ? servername : undefined).then(
      (socket) => callback?.(null, socket),
      (error: unknown) => callback?.(error instanceof Error ? error : new Error(String(error)), undefined as unknown as Duplex),
    )
    return undefined
  }

  private async open(host: string, port: number, servername: string | undefined): Promise<TLSSocket> {
    const raw = await openProxyTunnel(this.proxy, host, port, this.timeoutMs)
    // SNI must never carry an IP literal; fall back to the target hostname only when it is a name.
    const sni = servername !== undefined && isIP(servername) === 0
      ? servername
      : isIP(host) === 0 ? host : undefined
    const secure = connectTls({ socket: raw, servername: sni })
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', () => resolve())
      secure.once('error', (error) => reject(error))
    })
    return secure
  }
}

interface RawResponse {
  status: number
  statusText: string
  headers: IncomingHttpHeaders
  body: string
}

/** One HTTPS GET through the tunnel; the whole exchange (connect included) is bounded by `timeoutMs`. */
function requestThroughTunnel(target: URL, proxy: URL, timeoutMs: number): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const agent = new ProxyTunnelAgent(proxy, timeoutMs)
    let settled = false
    let request: ReturnType<typeof httpsRequest> | undefined
    const finish = (error: Error | null, value?: RawResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request?.destroy()
      agent.destroy()
      if (error === null && value !== undefined) resolve(value)
      else reject(error ?? new Error('catalog download failed'))
    }
    const timer = setTimeout(() => finish(new Error(`catalog download timed out after ${timeoutMs}ms`)), timeoutMs)
    request = httpsRequest(target, {
      agent,
      method: 'GET',
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    })
    request.once('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => {
        finish(null, {
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.once('error', (error) => finish(error))
    })
    request.once('error', (error) => finish(error))
    request.end()
  })
}

/**
 * Download and parse one HTTPS JSON document through an `http(s)://` proxy,
 * following redirects. Throws on a non-2xx answer, a malformed body, or a
 * transport timeout so callers keep the previously cached catalog.
 */
export async function fetchJsonViaProxy(url: string, proxy: string, timeoutMs: number): Promise<unknown> {
  let proxyUrl: URL
  try {
    proxyUrl = new URL(proxy)
  } catch {
    throw new Error(`proxy URL "${maskProxyUrl(proxy) ?? 'invalid'}" is not a URL`)
  }
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    throw new Error(`proxy URL "${maskProxyUrl(proxy) ?? 'invalid'}" uses ${proxyUrl.protocol}//, which is not supported`)
  }
  let current = new URL(url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:') {
      throw new Error(`proxy transport supports https targets only (got ${current.protocol}//)`)
    }
    const response = await requestThroughTunnel(current, proxyUrl, timeoutMs)
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.location
      if (typeof location !== 'string' || location === '') {
        throw new Error(`HTTP ${response.status} redirect without a Location header`)
      }
      current = new URL(location, current)
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`)
    }
    return JSON.parse(response.body) as unknown
  }
  throw new Error('too many redirects while downloading the catalog')
}

/**
 * Download the catalog for the settings page: defer to the harness when the
 * environment names a proxy, otherwise tunnel a detected OS proxy, otherwise
 * fetch directly. Never throws for routing reasons — transport failures do
 * throw, and the caller keeps its cached copy.
 * @param options - detection overrides; production passes nothing, tests pin
 *   the platform and its OS probes.
 */
export async function fetchJsonWithSystemProxy(
  url: string,
  timeoutMs: number,
  logger?: ProxyLogger,
  options: DetectOptions = {},
): Promise<CatalogFetchResult> {
  const route = await resolveCatalogRoute(url, options)
  for (const diagnostic of route.diagnostics) logger?.warn(`model-parameters: ${diagnostic}`)
  const transport = transportOf(route)
  logger?.info(`model-parameters: catalog download via ${describeTransport(transport)}`)
  try {
    const body = route.tunnel && route.proxy !== undefined && new URL(url).protocol === 'https:'
      ? await fetchJsonViaProxy(url, route.proxy, timeoutMs)
      : await fetchJsonDirect(url, timeoutMs)
    return { body, transport }
  } catch (error) {
    // The attempt's route rides the failure so the settings page can show what
    // was tried together with the error, instead of only the last good route.
    const wrapped = error instanceof Error ? error : new Error(String(error))
    ;(wrapped as { transport?: CatalogTransport }).transport = transport
    throw wrapped
  }
}
