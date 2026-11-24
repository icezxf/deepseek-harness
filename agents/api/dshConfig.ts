/**
 * 运行配置接口：读写 MCP 服务器、技能与全局规则。
 *
 * write 默认写当前会话；scope='global' 写全局容器，所有未接管的新会话都会继承。
 * 写入后会立刻停掉 sidecar，下一次 /api 请求按新配置重新拉起（页面刷新即生效）。
 */
import {
  applyConfigBundle,
  normalizeConfigBundle,
  readGlobalConfigBundle,
  readResolvedConfig,
  resetConfigToGlobal,
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
    const resolved = await readResolvedConfig(context, conversationId)
    const baseline = await readGlobalConfigBundle(context)
    return json({
      ok: true,
      bundle: resolved.bundle,
      source: resolved.source,
      hasGlobalBaseline: Boolean(
        baseline.instructions || baseline.mcpServers.length || baseline.skills.length,
      ),
    })
  }

  if (action === 'reset') {
    try {
      await resetConfigToGlobal(context, conversationId)
    } catch (error) {
      return json({
        ok: false,
        error: `恢复全局配置失败：${error instanceof Error ? error.message : String(error)}`,
      }, 500)
    }
    let restarted = false
    try {
      restarted = await stopDshWebSidecar(conversationId)
    } catch (error) {
      console.warn('[dsh-web] config restart failed:', error)
    }
    const resolved = await readResolvedConfig(context, conversationId)
    return json({ ok: true, bundle: resolved.bundle, source: resolved.source, restarted })
  }

  if (action === 'write') {
    const scope = body.scope === 'global' ? 'global' : 'session'
    let bundle
    try {
      bundle = normalizeConfigBundle(body.bundle)
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
    try {
      await applyConfigBundle(context, conversationId, bundle, scope)
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
    return json({ ok: true, bundle, source: scope === 'global' ? 'global' : 'session', scope, restarted })
  }

  return json({ ok: false, error: '未知操作' }, 400)
}
