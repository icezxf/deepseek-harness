import WebSocket from 'ws'
import { getDshWebSidecar, snapshotDshSettingsYaml, type DshWebSidecar } from '../_dsh-web-sidecar.ts'

function requestPath(context: any): string {
  const value = typeof context.request?.url === 'string' ? context.request.url : '/api'
  try { return new URL(value, 'http://local').pathname } catch { return '/api' }
}

function requestSearch(context: any, incomingUrl: URL): string {
  if (incomingUrl.search) return incomingUrl.search
  const query = context.request?.query
  if (!query || typeof query !== 'object' || Array.isArray(query)) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.set(key, String(value))
    }
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

function eventStream(context: any, kind: 'mux' | 'host'): Response {
  const encoder = new TextEncoder()
  let socket: WebSocket | undefined
  const signal = context.request?.signal as AbortSignal | undefined
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const streamError = (error: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'server-request',
            rpcId: crypto.randomUUID(),
            method: 'stream/error',
            payload: {
              type: 'stream/error',
              error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
            },
          })}\n\n`))
        } catch {
          // The browser already disconnected.
        }
        try { controller.close() } catch { /* already cancelled */ }
      }
      try {
        const sidecar = await getDshWebSidecar(context)
        const path = kind === 'mux' ? '/api/events.mux' : '/api/events.host'
        socket = new WebSocket(`ws://127.0.0.1:${String(sidecar.port)}${path}`, {
          headers: { origin: `http://127.0.0.1:${String(sidecar.port)}` },
        })
        const close = (): void => {
          if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) socket.close()
        }
        signal?.addEventListener('abort', close, { once: true })
        socket.once('open', () => {
          try { controller.enqueue(encoder.encode(': connected\n\n')) } catch { close() }
        })
        socket.on('message', data => {
          try { controller.enqueue(encoder.encode(`data: ${data.toString()}\n\n`)) } catch { close() }
        })
        socket.once('error', streamError)
        socket.once('close', () => {
          signal?.removeEventListener('abort', close)
          try { controller.close() } catch { /* already cancelled */ }
        })
      } catch (error) {
        streamError(error)
      }
    },
    cancel() {
      if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) socket.close()
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

const LOCKED_BUILT_IN_PRESETS = new Set(['standard', 'code', 'minimal', 'cordis'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requestedLockedPreset(body: unknown): string | undefined {
  const envelope = asRecord(body)
  const method = typeof envelope?.method === 'string' ? envelope.method : ''
  const payload = asRecord(envelope?.payload) ?? {}
  if (method === 'agentPreset.select') {
    const id = String(payload.agentPreset || '')
    return LOCKED_BUILT_IN_PRESETS.has(id) ? id : undefined
  }
  if (payload.ns !== 'agent-presets') return undefined
  if (method === 'settings.update') {
    const id = String(asRecord(payload.patch)?.default || '')
    return LOCKED_BUILT_IN_PRESETS.has(id) ? id : undefined
  }
  if (method === 'settings.replace') {
    const id = String(asRecord(payload.section)?.default || '')
    return LOCKED_BUILT_IN_PRESETS.has(id) ? id : undefined
  }
  if (method === 'settings.mutate' && Array.isArray(payload.ops)) {
    for (const op of payload.ops) {
      const edit = asRecord(op)
      const path = Array.isArray(edit?.path) ? edit.path : []
      if (edit?.op === 'set' && path.length === 1 && path[0] === 'default') {
        const id = String(edit.value || '')
        if (LOCKED_BUILT_IN_PRESETS.has(id)) return id
      }
    }
  }
  return undefined
}

function rejectLockedPreset(rpcId: unknown, agentPreset: string): Response {
  return Response.json({
    type: 'server-response',
    rpcId: typeof rpcId === 'string' && rpcId.length > 0 ? rpcId : crypto.randomUUID(),
    result: {
      ok: false,
      error: {
        code: 'agent-preset-read-only',
        message: `Built-in agent preset "${agentPreset}" is not selectable on EdgeOne Makers.`,
        details: {
          agentPreset,
          reason: 'locked on EdgeOne Makers',
        },
      },
    },
  })
}

const SETTINGS_WRITE_PATHS = new Set([
  '/api/settings.update',
  '/api/settings.replace',
  '/api/settings.mutate',
])

function settingsWriteSucceeded(bytes: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { result?: { ok?: boolean } }
    return parsed.result?.ok === true
  } catch {
    return false
  }
}

async function snapshotSettingsAfterWrite(
  context: any,
  sidecar: DshWebSidecar,
  path: string,
  upstream: Response,
  headers: Headers,
): Promise<Response | undefined> {
  if (!SETTINGS_WRITE_PATHS.has(path)) return undefined
  const bytes = new Uint8Array(await upstream.arrayBuffer())
  headers.set('content-length', String(bytes.byteLength))
  if (upstream.ok && settingsWriteSucceeded(bytes)) {
    try {
      await snapshotDshSettingsYaml(context, sidecar.conversationId, sidecar.home)
    } catch (error) {
      console.warn('[dsh-web] settings snapshot failed:', error)
    }
  }
  return new Response(bytes, { status: upstream.status, headers })
}

async function proxy(context: any): Promise<Response> {
  const path = requestPath(context)
  if (path === '/api/events.mux') return eventStream(context, 'mux')
  if (path === '/api/events.host') return eventStream(context, 'host')

  const incomingBody = context.request?.body
  const lockedPreset = requestedLockedPreset(incomingBody)
  if (lockedPreset) return rejectLockedPreset(asRecord(incomingBody)?.rpcId, lockedPreset)

  const sidecar = await getDshWebSidecar(context)
  const incomingUrl = new URL(typeof context.request?.url === 'string' ? context.request.url : path, 'http://local')
  const upstreamUrl = new URL(`${incomingUrl.pathname}${requestSearch(context, incomingUrl)}`, `http://127.0.0.1:${String(sidecar.port)}`)
  const method = String(context.request?.method || 'POST').toUpperCase()
  const body = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(context.request?.body ?? {})
  const upstream = await fetch(upstreamUrl, {
    method,
    headers: {
      accept: context.request?.headers?.accept || '*/*',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
    signal: context.request?.signal,
  })
  const headers = new Headers(upstream.headers)
  headers.delete('content-length')
  headers.delete('transfer-encoding')
  if (path === '/api/session.export' && method === 'GET') {
    const bytes = new Uint8Array(await upstream.arrayBuffer())
    if (!headers.has('content-type')) headers.set('content-type', 'application/zip')
    // Makers' strict stream detector only treats SSE / chunked / this flag as binary.
    // Without it the runtime UTF-8-decodes the ZIP and the local proxy then writes
    // leftover bytes into an already-ended response (ERR_STREAM_WRITE_AFTER_END).
    headers.set('x-content-type-stream', 'true')
    headers.set('cache-control', 'no-store')
    return new Response(bytes, { status: upstream.status, headers })
  }
  const settingsResponse = await snapshotSettingsAfterWrite(context, sidecar, path, upstream, headers)
  if (settingsResponse) return settingsResponse
  return new Response(upstream.body, { status: upstream.status, headers })
}

// ---- 访问密码二次校验（与根目录 middleware.js 共用 dsh_gate cookie 约定）----
// 平台中间件是第一道门；这里在 Agent 入口再验一次，避免 middleware 未覆盖
// agents 路由时 API 被绕过。fail-closed：未配置密钥直接拒绝，避免静默放行。
const GATE_COOKIE = 'dsh_gate'
const gateEncoder = new TextEncoder()

function gateHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function gateSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', gateEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return gateHex(await crypto.subtle.sign('HMAC', key, gateEncoder.encode(data)))
}

function gateSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function gateReadCookie(header: string, name: string): string {
  if (!header) return ''
  for (const chunk of header.split(';')) {
    const index = chunk.indexOf('=')
    if (index < 0) continue
    if (chunk.slice(0, index).trim() === name) return chunk.slice(index + 1).trim()
  }
  return ''
}

async function denyUnauthenticated(context: any): Promise<Response | null> {
  const secret = String(context?.env?.DSH_AUTH_SECRET || '')
  if (!secret) {
    return Response.json({ error: 'AUTH_NOT_CONFIGURED', message: '服务端未配置 DSH_AUTH_SECRET' }, { status: 503 })
  }
  let cookie = ''
  try { cookie = String(context?.request?.headers?.get?.('cookie') || '') } catch { cookie = '' }
  const token = gateReadCookie(cookie, GATE_COOKIE)
  const dot = token.lastIndexOf('.')
  if (dot > 0) {
    const expires = token.slice(0, dot)
    const signature = token.slice(dot + 1)
    const stamp = Number(expires)
    if (Number.isFinite(stamp) && stamp >= Date.now() && gateSafeEqual(await gateSign(secret, expires), signature)) {
      return null
    }
  }
  return Response.json({ error: 'UNAUTHORIZED', message: '需要访问密码' }, { status: 401 })
}

export async function onRequest(context: any): Promise<Response> {
  const denied = await denyUnauthenticated(context)
  if (denied) return denied
  try {
    return await proxy(context)
  } catch (error) {
    return Response.json({
      error: 'DSH_WEB_PROXY_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
}
