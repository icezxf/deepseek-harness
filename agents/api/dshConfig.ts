/**
 * 运行配置接口：读写会话级的 MCP 服务器、技能与全局规则。
 *
 * 配置存在 conversation metadata 里，写入后立刻停掉 sidecar；
 * 下一次 /api 请求会带着新配置重新拉起（页面刷新即可生效）。
 */
import {
  normalizeConfigBundle,
  readConfigBundle,
  saveConfigBundle,
} from '../_dsh-config.ts'
import { stopDshWebSidecar } from '../_dsh-web-sidecar.ts'
import { denyUnauthenticated } from './_proxy.ts'

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
}

export async function onRequest(context: any): Promise<Response> {
  const denied = await denyUnauthenticated(context)
  if (denied) return denied

  const conversationId = String(context.conversation_id || '').trim()
  if (!conversationId) return json({ ok: false, error: '缺少会话标识，请刷新页面后重试' }, 400)

  const body = context.request?.body
  const action = body && typeof body === 'object' && typeof body.action === 'string' ? body.action : ''

  if (action === 'read') {
    const bundle = await readConfigBundle(context, conversationId)
    return json({ ok: true, bundle })
  }

  if (action === 'write') {
    let bundle
    try {
      bundle = normalizeConfigBundle(body.bundle)
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
    try {
      await saveConfigBundle(context, conversationId, bundle)
    } catch (error) {
      return json({
        ok: false,
        error: `保存失败：${error instanceof Error ? error.message : String(error)}`,
      }, 500)
    }
    let restarted = false
    try {
      restarted = await stopDshWebSidecar(conversationId)
    } catch (error) {
      console.warn('[dsh-web] config restart failed:', error)
    }
    return json({ ok: true, bundle, restarted })
  }

  return json({ ok: false, error: '未知操作' }, 400)
}
