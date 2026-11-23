/**
 * 会话级运行配置：MCP 服务器、技能（SKILL.md）与全局规则（AGENTS.md）。
 *
 * 这些内容原本硬编码在 sidecar 的 writeProfilePatch 里，每次冷启动被覆盖，
 * 用户在界面里改了也留不下来。这里把配置存进 conversation metadata
 * （与 settings.yaml 的快照同一套机制），冷启动时再还原成 $DSH_HOME 下的文件。
 *
 * @module _dsh-config
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DSH_CONFIG_METADATA_KEY = 'dshConfigBundle'
/** 会话是否接管了全局基线：'session' 表示用会话自己的配置，'global' 表示继承环境变量。 */
export const DSH_CONFIG_MODE_METADATA_KEY = 'dshConfigMode'
/** 部署级默认配置：一次设好，所有新会话自动继承，相当于 CF 那边写在 wrangler 里的常量。 */
export const DSH_CONFIG_ENV_KEY = 'DSH_CONFIG_JSON'

const MAX_INSTRUCTIONS_BYTES = 16 * 1024
const MAX_SKILL_BYTES = 32 * 1024
const MAX_SKILLS_TOTAL_BYTES = 192 * 1024
const MAX_SKILLS = 20
const MAX_MCP_SERVERS = 10
const MAX_MCP_HEADERS = 10
const MAX_SERVER_NAME = 48
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface DshMcpServerConfig {
  id: string
  name: string
  url: string
  headers: Record<string, string>
  enabled: boolean
}

export interface DshSkillConfig {
  name: string
  description: string
  body: string
}

export interface DshConfigBundle {
  version: 1
  instructions: string
  mcpServers: DshMcpServerConfig[]
  skills: DshSkillConfig[]
  updatedAt: string
}

export function emptyConfigBundle(): DshConfigBundle {
  return { version: 1, instructions: '', mcpServers: [], skills: [], updatedAt: '' }
}

function bytes(text: string): number {
  try {
    return new TextEncoder().encode(text).byteLength
  } catch {
    return text.length
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function fail(message: string): never {
  throw new Error(message)
}

function normalizeName(raw: unknown, label: string): string {
  const name = asText(raw).trim().toLowerCase()
  if (!name) fail(`${label}不能为空`)
  if (name.length > MAX_SERVER_NAME) fail(`${label}最长 ${String(MAX_SERVER_NAME)} 个字符`)
  if (!KEBAB.test(name)) fail(`${label}只能使用小写字母、数字和连字符，例如 my-server`)
  return name
}

function normalizeServer(raw: unknown, index: number): DshMcpServerConfig {
  const row = asRecord(raw)
  if (!row) fail(`第 ${String(index + 1)} 个 MCP 服务器格式不正确`)
  const name = normalizeName(row.name, `第 ${String(index + 1)} 个 MCP 服务器名称`)
  const url = asText(row.url).trim()
  if (!/^https?:\/\//i.test(url)) fail(`MCP 服务器 ${name} 需要 http(s) 地址`)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    fail(`MCP 服务器 ${name} 的地址无法解析`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(`MCP 服务器 ${name} 只支持 http(s)`)
  const headerSource = asRecord(row.headers)
  const headers: Record<string, string> = {}
  if (headerSource) {
    const entries = Object.entries(headerSource).slice(0, MAX_MCP_HEADERS)
    for (const [key, value] of entries) {
      const headerName = key.trim()
      if (!headerName || !/^[A-Za-z0-9-]+$/.test(headerName)) fail(`MCP 服务器 ${name} 的请求头名称不合法：${key}`)
      headers[headerName] = asText(value)
    }
  }
  return {
    id: asText(row.id).trim() || name,
    name,
    url,
    headers,
    enabled: row.enabled === undefined ? true : row.enabled === true,
  }
}

function normalizeSkill(raw: unknown, index: number): DshSkillConfig {
  const row = asRecord(raw)
  if (!row) fail(`第 ${String(index + 1)} 个技能格式不正确`)
  const name = normalizeName(row.name, `第 ${String(index + 1)} 个技能名称`)
  const description = asText(row.description).replace(/\s+/g, ' ').trim()
  if (!description) fail(`技能 ${name} 需要一句话描述，模型靠它判断何时加载`)
  if (description.length > 400) fail(`技能 ${name} 的描述最长 400 个字符`)
  const body = asText(row.body)
  if (bytes(body) > MAX_SKILL_BYTES) fail(`技能 ${name} 的正文超过 ${String(MAX_SKILL_BYTES / 1024)} KB`)
  return { name, description, body }
}

/** 校验并归一化界面提交的配置；任何不合法都会抛出可直接展示给用户的中文错误。 */
export function normalizeConfigBundle(raw: unknown): DshConfigBundle {
  const source = asRecord(raw) ?? {}
  const instructions = asText(source.instructions)
  if (bytes(instructions) > MAX_INSTRUCTIONS_BYTES) {
    fail(`全局规则超过 ${String(MAX_INSTRUCTIONS_BYTES / 1024)} KB，请精简`)
  }

  const rawServers = Array.isArray(source.mcpServers) ? source.mcpServers : []
  if (rawServers.length > MAX_MCP_SERVERS) fail(`最多配置 ${String(MAX_MCP_SERVERS)} 个 MCP 服务器`)
  const servers: DshMcpServerConfig[] = []
  const seenServers = new Set<string>()
  rawServers.forEach((entry, index) => {
    const server = normalizeServer(entry, index)
    if (seenServers.has(server.name)) fail(`MCP 服务器名称重复：${server.name}`)
    seenServers.add(server.name)
    servers.push(server)
  })

  const rawSkills = Array.isArray(source.skills) ? source.skills : []
  if (rawSkills.length > MAX_SKILLS) fail(`最多配置 ${String(MAX_SKILLS)} 个技能`)
  const skills: DshSkillConfig[] = []
  const seenSkills = new Set<string>()
  let total = 0
  rawSkills.forEach((entry, index) => {
    const skill = normalizeSkill(entry, index)
    if (seenSkills.has(skill.name)) fail(`技能名称重复：${skill.name}`)
    seenSkills.add(skill.name)
    total += bytes(skill.body) + bytes(skill.description)
    skills.push(skill)
  })
  if (total > MAX_SKILLS_TOTAL_BYTES) fail('技能正文合计过大，请拆分或精简')

  return {
    version: 1,
    instructions,
    mcpServers: servers,
    skills,
    updatedAt: new Date().toISOString(),
  }
}

/** SKILL.md 内容：frontmatter 只保留 skill-filesystem 必填的两个字段。 */
export function skillMarkdown(skill: DshSkillConfig): string {
  const description = skill.description.replace(/[\r\n]+/g, ' ').trim()
  const body = skill.body.trim()
  return ['---', `name: ${skill.name}`, `description: ${JSON.stringify(description)}`, '---', '', body, ''].join('\n')
}

/** 把配置落成 $DSH_HOME 下的 AGENTS.md 与 skills/<name>/SKILL.md。 */
export async function writeConfigFiles(home: string, bundle: DshConfigBundle): Promise<void> {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'AGENTS.md'), bundle.instructions.trim() ? `${bundle.instructions.trim()}\n` : '')
  const skillsRoot = join(home, 'skills')
  // 同一会话的 /tmp home 在重启后仍然存在，先清空再写，删掉的技能才不会残留。
  await rm(skillsRoot, { recursive: true, force: true })
  await mkdir(skillsRoot, { recursive: true })
  for (const skill of bundle.skills) {
    const dir = join(skillsRoot, skill.name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skillMarkdown(skill))
  }
}

async function getConversationRow(context: any, conversationId: string): Promise<any> {
  const store = context?.store
  if (!store) return undefined
  try {
    return await store.getConversation({ conversationId })
  } catch (firstError) {
    try {
      return await store.getConversation(conversationId)
    } catch {
      return undefined
    }
  }
}

export type DshConfigSource = 'session' | 'global' | 'empty'

/** 解析部署级基线（环境变量 DSH_CONFIG_JSON）；没配或写错都当作空基线，不影响启动。 */
export function readGlobalConfigBundle(context: any): DshConfigBundle {
  const raw = context?.env?.[DSH_CONFIG_ENV_KEY]
  if (typeof raw !== 'string' || !raw.trim()) return emptyConfigBundle()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.warn('[dsh-web] DSH_CONFIG_JSON is not valid JSON:', error)
    return emptyConfigBundle()
  }
  try {
    return normalizeConfigBundle(parsed)
  } catch (error) {
    console.warn('[dsh-web] DSH_CONFIG_JSON rejected:', error)
    return emptyConfigBundle()
  }
}

/**
 * 解析当前生效的配置。
 *
 * 优先级：会话显式接管 > 会话已保存的配置 > 部署级基线。
 * 会话保存过一次就完全接管，不会出现"删了一条规则又冒回基线"的困惑。
 */
export async function readResolvedConfig(
  context: any,
  conversationId: string,
): Promise<{ bundle: DshConfigBundle; source: DshConfigSource }> {
  const baseline = readGlobalConfigBundle(context)
  let stored: unknown
  let mode = ''
  try {
    const row = await getConversationRow(context, conversationId)
    stored = row?.metadata?.[DSH_CONFIG_METADATA_KEY]
    const rawMode = row?.metadata?.[DSH_CONFIG_MODE_METADATA_KEY]
    mode = typeof rawMode === 'string' ? rawMode : ''
  } catch (error) {
    console.warn('[dsh-web] config bundle ignored:', error)
  }

  if (mode === 'global') {
    return baseline.instructions || baseline.mcpServers.length || baseline.skills.length
      ? { bundle: baseline, source: 'global' }
      : { bundle: emptyConfigBundle(), source: 'empty' }
  }

  if (stored) {
    try {
      return { bundle: normalizeConfigBundle(stored), source: 'session' }
    } catch (error) {
      console.warn('[dsh-web] stored config bundle rejected:', error)
    }
  }

  return baseline.instructions || baseline.mcpServers.length || baseline.skills.length
    ? { bundle: baseline, source: 'global' }
    : { bundle: emptyConfigBundle(), source: 'empty' }
}

/** 读取会话实际生效的配置；给 sidecar 启动用，不关心来源。 */
export async function readConfigBundle(context: any, conversationId: string): Promise<DshConfigBundle> {
  const resolved = await readResolvedConfig(context, conversationId)
  return resolved.bundle
}

/** 放弃会话覆盖，重新继承全局基线。 */
export async function resetConfigToGlobal(context: any, conversationId: string): Promise<void> {
  const store = context?.store
  if (!store) throw new Error('会话存储不可用')
  const metadata = { [DSH_CONFIG_MODE_METADATA_KEY]: 'global', [DSH_CONFIG_METADATA_KEY]: null }
  try {
    await store.updateConversation({ conversationId, metadata })
  } catch {
    try {
      await store.updateConversation(conversationId, { metadata })
      return
    } catch {
      await ensureConversation(store, conversationId)
      await store.updateConversation({ conversationId, metadata })
    }
  }
}

/** 会话还没有任何消息时，metadata 写不进去；先补一条引导消息把会话建出来。 */
async function ensureConversation(store: any, conversationId: string): Promise<void> {
  const payload = {
    conversationId,
    role: 'system' as const,
    content: 'dsh-settings',
    metadata: { kind: 'dsh-settings-bootstrap' },
  }
  try {
    await store.appendMessage(payload)
  } catch (firstError) {
    try {
      await store.appendMessage(conversationId, payload)
    } catch {
      throw firstError
    }
  }
}

/** 写入会话配置（只改一个 metadata 键，不动 settings.yaml 快照）。 */
export async function saveConfigBundle(context: any, conversationId: string, bundle: DshConfigBundle): Promise<void> {
  const store = context?.store
  if (!store) throw new Error('会话存储不可用')
  const metadata = {
    [DSH_CONFIG_METADATA_KEY]: bundle,
    [DSH_CONFIG_MODE_METADATA_KEY]: 'session',
  }
  try {
    await store.updateConversation({ conversationId, metadata })
  } catch {
    try {
      await store.updateConversation(conversationId, { metadata })
      return
    } catch {
      // 会话还不存在，补一条引导消息后重试。
    }
    await ensureConversation(store, conversationId)
    await store.updateConversation({ conversationId, metadata })
  }
}
