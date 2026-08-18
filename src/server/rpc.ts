/**
 * Fenced JSON API under /plugins/@fonlan/dsh-model-parameters/api/<method> for
 * the web settings page. Same browser-trust fence as the /api gateway and the
 * model-router plugin: loopback Host-header or configured trustedHosts,
 * same-origin browser markers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ModelParametersService } from './service.js'

const API_PREFIX = '/plugins/@fonlan/dsh-model-parameters/api'

// ── browser-trust fence (mirrors dsh-client-connection's api-request-trust) ──

function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isTrustedApiRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname) && !trustedHosts.includes(hostUrl.host) && !trustedHosts.includes(hostUrl.hostname)) {
    return false
  }
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function trustedHostsOf(ctx: Context): string[] {
  for (const entry of ctx.get('loader')?.entries?.() ?? []) {
    if (entry.options?.name === 'connection') {
      const config = entry.options.config as { trustedHosts?: string[] } | undefined
      return config?.trustedHosts ?? []
    }
  }
  return []
}

// ── wire helpers ────────────────────────────────────────────────────────────

function writeJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function writeError(res: ServerResponse, code: string, message: string, status = 400): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok: false, error: { code, message } }))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

// ── routes ──────────────────────────────────────────────────────────────────

export function registerApiRoutes(ctx: Context, service: ModelParametersService): () => void {
  const fence = (req: IncomingMessage): boolean => isTrustedApiRequest(req, trustedHostsOf(ctx))
  const disposers: Array<() => void> = []

  const route = (name: string, handler: (payload: Record<string, unknown>) => Promise<unknown>): void => {
    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: `${API_PREFIX}/${name}`,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!fence(req)) {
          writeError(res, 'forbidden', 'forbidden', 403)
          return
        }
        if (req.method !== 'POST' && req.method !== 'GET') {
          writeError(res, 'method', 'method not allowed', 405)
          return
        }
        const payload = await readJsonBody(req)
        try {
          const value = await handler(payload)
          writeJson(res, { ok: true, value })
        } catch (error) {
          writeError(res, 'error', error instanceof Error ? error.message : String(error))
        }
      },
    }))
  }

  route('state', async () => stateOf(service))

  route('refresh', async () => {
    await service.refreshAndReconcile()
    return stateOf(service)
  })

  route('reconcile', async () => {
    await service.reconcile()
    return stateOf(service)
  })

  route('set-config', async (payload) => {
    const patch = payload.patch
    if (typeof patch !== 'object' || patch === null) throw new Error('patch must be an object')
    await service.updateConfig(patch as never)
    return stateOf(service)
  })

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * The settings-page view. Deliberately ships only catalog COUNTS — the full
 * entries array (thousands of models) must never cross the wire or render.
 */
function stateOf(service: ModelParametersService): unknown {
  const config = service.config()
  const snapshot = service.catalogSnapshot()
  return {
    config,
    catalog: {
      entries: snapshot.entries.length,
      providers: snapshot.providers,
      fetchedAt: snapshot.fetchedAt,
      fresh: snapshot.fetchedAt > 0
        && Date.now() - snapshot.fetchedAt < config.ttlDays * 24 * 60 * 60 * 1000,
      ttlDays: config.ttlDays,
    },
    report: service.report(),
  }
}
