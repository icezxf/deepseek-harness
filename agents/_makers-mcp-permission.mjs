/** DSH plugin: keep every Makers MCP tool in the prompt, ask the user when the current mode does not auto-allow it. */
export const name = 'makers-mcp-permission'
export const inject = ['tools']

export const MCP_SERVER_NAME = 'edgeone'
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`
export const DEFAULT_MAKERS_PERMISSION = 'workspace-write'

export const ALL_MAKERS_TOOLS = Object.freeze([
  'makers_context_probe',
  'workspace_list_files',
  'workspace_read_file',
  'workspace_write_file',
  'workspace_run_command',
  'publish_preview',
  'sandbox_probe',
  'sandbox_wait',
  'dsh_config_read',
  'dsh_config_write',
])

const AUTO_ALLOW = Object.freeze({
  'read-only': Object.freeze(['makers_context_probe', 'workspace_list_files', 'workspace_read_file', 'dsh_config_read']),
  'workspace-write': Object.freeze([
    'makers_context_probe',
    'workspace_list_files',
    'workspace_read_file',
    'workspace_write_file',
    'dsh_config_read',
  ]),
  'danger-full-access': ALL_MAKERS_TOOLS,
})

/** 改写运行配置会持久化到会话/全局，任何权限模式下都要单独确认。 */
const ALWAYS_ASK = Object.freeze(['dsh_config_write'])

export function isMakersPermissionMode(value) {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

export function makersAutoAllowTools(mode) {
  return AUTO_ALLOW[isMakersPermissionMode(mode) ? mode : DEFAULT_MAKERS_PERMISSION]
}

export function makersToolAllowed(mode, tool) {
  return makersAutoAllowTools(mode).includes(tool)
}

export function makersRequiredMode(tool) {
  return tool === 'workspace_write_file' || tool === 'dsh_config_write' ? 'workspace-write' : 'danger-full-access'
}

export function makersRequiredModeLabel(tool) {
  return makersRequiredMode(tool) === 'workspace-write' ? 'Workspace Write' : 'Full access'
}

export function makersToolGate(mode, tool) {
  if (ALWAYS_ASK.includes(tool)) return 'ask'
  return makersToolAllowed(mode, tool) ? 'allow' : 'ask'
}

export function makersAskReason(mode, tool) {
  if (tool === 'dsh_config_write') {
    return `⚙️ 正在修改已保存的全局规则 / MCP / 技能，重启后依然生效。这是长期配置变更，仅本次授权。\nThe ${tool} tool will rewrite your saved rules / MCP servers / skills and survives restarts. Allow this one call?`
  }
  const need = makersRequiredModeLabel(tool)
  return `🔒 EdgeOne 云端沙箱请求执行「${tool}」：它需要在 ${need}（当前 ${mode}）下运行${tool === 'workspace_run_command' ? '命令' : tool === 'publish_preview' ? '并发布预览' : ''}，仅影响云端隔离沙箱，不会碰你的本机。仅本次允许？想少弹请到 设置→权限 切到 Full access。\nThe ${tool} tool needs ${need} on EdgeOne Makers. Current permission is ${mode}. Allow this one call?`
}

export function makersRawToolName(publicName) {
  if (typeof publicName !== 'string' || !publicName.startsWith(MCP_TOOL_PREFIX)) return null
  return publicName.slice(MCP_TOOL_PREFIX.length)
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', (exec, next) => {
    const tool = makersRawToolName(exec.name)
    if (!tool) return next()
    const sandboxPolicy = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : ctx.sandboxPolicy
    const mode = sandboxPolicy?.resolve?.({ session: exec.agent?.session })?.mode
    const current = isMakersPermissionMode(mode) ? mode : DEFAULT_MAKERS_PERMISSION
    if (makersToolGate(current, tool) === 'allow') return next()
    return { kind: 'ask', reason: makersAskReason(current, tool) }
  })
}

export function makersMcpPermissionSource() {
  const declarations = [
    `export const name = ${JSON.stringify(name)}`,
    `export const inject = ${JSON.stringify(inject)}`,
    `export const MCP_SERVER_NAME = ${JSON.stringify(MCP_SERVER_NAME)}`,
    'export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`',
    `export const DEFAULT_MAKERS_PERMISSION = ${JSON.stringify(DEFAULT_MAKERS_PERMISSION)}`,
    `export const ALL_MAKERS_TOOLS = Object.freeze(${JSON.stringify(ALL_MAKERS_TOOLS)})`,
    `const AUTO_ALLOW = Object.freeze(${JSON.stringify(AUTO_ALLOW)})`,
    `const ALWAYS_ASK = Object.freeze(${JSON.stringify(ALWAYS_ASK)})`,
  ]
  const functions = [
    isMakersPermissionMode,
    makersAutoAllowTools,
    makersToolAllowed,
    makersRequiredMode,
    makersRequiredModeLabel,
    makersToolGate,
    makersAskReason,
    makersRawToolName,
    apply,
  ]
  return [
    ...declarations,
    ...functions.map(fn => `export ${fn.toString()}`),
    '',
  ].join('\n\n')
}
