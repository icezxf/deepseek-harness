import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DSH_CONFIG_METADATA_KEY,
  normalizeConfigBundle,
  readConfigBundle,
  readGlobalConfigBundle,
  readResolvedConfig,
  resetConfigToGlobal,
  saveConfigBundle,
  skillMarkdown,
  writeConfigFiles,
} from '../agents/_dsh-config.ts'

function createStore(conversations = new Map<string, { metadata: Record<string, unknown> }>()) {
  return {
    conversations,
    async getConversation({ conversationId }: { conversationId: string }) {
      const row = conversations.get(conversationId)
      if (!row) throw Object.assign(new Error('Conversation not found'), { code: 'MemoryNotFoundError' })
      return row
    },
    async updateConversation({
      conversationId,
      metadata,
    }: {
      conversationId: string
      metadata: Record<string, unknown>
    }) {
      const row = conversations.get(conversationId)
      if (!row) throw Object.assign(new Error('Conversation not found'), { code: 'MemoryNotFoundError' })
      row.metadata = { ...row.metadata, ...metadata }
      return row
    },
  }
}

test('normalizeConfigBundle accepts a valid bundle and trims values', () => {
  const bundle = normalizeConfigBundle({
    instructions: '  始终用中文回答  ',
    mcpServers: [
      { name: ' Context7 ', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t' } },
    ],
    skills: [{ name: 'pdf-report', description: '生成 PDF 报告', body: '# 步骤\n1. 读数据' }],
  })
  assert.equal(bundle.instructions, '  始终用中文回答  ')
  assert.equal(bundle.mcpServers[0]?.name, 'context7')
  assert.equal(bundle.mcpServers[0]?.enabled, true)
  assert.deepEqual(bundle.mcpServers[0]?.headers, { Authorization: 'Bearer t' })
  assert.equal(bundle.skills[0]?.name, 'pdf-report')
  assert.match(bundle.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('normalizeConfigBundle rejects an empty MCP name and a non-http url', () => {
  assert.throws(() => normalizeConfigBundle({ mcpServers: [{ name: '', url: 'https://x.dev/mcp' }] }), /不能为空/)
  assert.throws(() => normalizeConfigBundle({ mcpServers: [{ name: 'ok', url: 'ftp://x.dev' }] }), /http\(s\)/)
  assert.throws(() => normalizeConfigBundle({ mcpServers: [{ name: 'Bad Name', url: 'https://x.dev' }] }), /小写字母/)
})

test('normalizeConfigBundle rejects duplicate names and oversized instructions', () => {
  assert.throws(() => normalizeConfigBundle({
    mcpServers: [
      { name: 'dup', url: 'https://a.dev/mcp' },
      { name: 'dup', url: 'https://b.dev/mcp' },
    ],
  }), /重复/)
  assert.throws(() => normalizeConfigBundle({ instructions: 'x'.repeat(17 * 1024) }), /KB/)
})

test('skillMarkdown writes the required frontmatter fields', () => {
  const markdown = skillMarkdown({ name: 'pdf-report', description: '生成 PDF\n报告', body: '# 步骤' })
  assert.match(markdown, /^---\nname: pdf-report\ndescription: "生成 PDF 报告"\n---\n\n# 步骤\n$/)
})

test('writeConfigFiles restores AGENTS.md and clears stale skills', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-config-'))
  try {
    await writeConfigFiles(home, normalizeConfigBundle({
      instructions: '规则一',
      skills: [{ name: 'alpha', description: 'a', body: 'A' }],
    }))
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '规则一\n')
    assert.match(await readFile(join(home, 'skills', 'alpha', 'SKILL.md'), 'utf8'), /name: alpha/)

    await writeConfigFiles(home, normalizeConfigBundle({ instructions: '', skills: [] }))
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '')
    await assert.rejects(readFile(join(home, 'skills', 'alpha', 'SKILL.md'), 'utf8'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('config bundle round-trips through conversation metadata', async () => {
  const store = createStore(new Map([['conv-1', { metadata: { dshSettingsYaml: 'locale:\n  preference: zh\n' } }]]))
  const bundle = normalizeConfigBundle({
    instructions: '全局规则',
    mcpServers: [{ name: 'context7', url: 'https://mcp.example.com/mcp' }],
    skills: [{ name: 'alpha', description: 'a', body: 'A' }],
  })
  await saveConfigBundle({ store }, 'conv-1', bundle)
  const restored = await readConfigBundle({ store }, 'conv-1')
  assert.equal(restored.instructions, '全局规则')
  assert.equal(restored.mcpServers.length, 1)
  assert.equal(restored.skills.length, 1)
  // 不得覆盖 settings.yaml 快照
  assert.equal(store.conversations.get('conv-1')?.metadata.dshSettingsYaml, 'locale:\n  preference: zh\n')
  assert.ok(store.conversations.get('conv-1')?.metadata[DSH_CONFIG_METADATA_KEY])
})

test('readConfigBundle falls back to an empty bundle for unknown conversations', async () => {
  const restored = await readConfigBundle({ store: createStore() }, 'missing')
  assert.deepEqual(restored.mcpServers, [])
  assert.equal(restored.instructions, '')
})

test('saveConfigBundle bootstraps a conversation that has no messages yet', async () => {
  const conversations = new Map<string, { metadata: Record<string, unknown> }>()
  const store = {
    async getConversation() {
      const row = conversations.get('conv-new')
      if (!row) throw Object.assign(new Error('Conversation not found'), { code: 'MemoryNotFoundError' })
      return row
    },
    async appendMessage({ conversationId }: { conversationId: string }) {
      if (!conversations.has(conversationId)) conversations.set(conversationId, { metadata: {} })
    },
    async updateConversation({
      conversationId,
      metadata,
    }: {
      conversationId: string
      metadata: Record<string, unknown>
    }) {
      const row = conversations.get(conversationId)
      if (!row) throw Object.assign(new Error('Conversation not found'), { code: 'MemoryNotFoundError' })
      row.metadata = { ...row.metadata, ...metadata }
      return row
    },
  }
  await saveConfigBundle({ store }, 'conv-new', normalizeConfigBundle({ instructions: '规则' }))
  assert.equal(conversations.get('conv-new')?.metadata.dshConfigBundle ? 'ok' : '', 'ok')
})

test('readGlobalConfigBundle parses DSH_CONFIG_JSON and ignores broken values', () => {
  const env = {
    DSH_CONFIG_JSON: JSON.stringify({
      instructions: '部署级规则',
      mcpServers: [{ name: 'global-mcp', url: 'https://mcp.example.com/mcp' }],
    }),
  }
  const baseline = readGlobalConfigBundle({ env })
  assert.equal(baseline.instructions, '部署级规则')
  assert.equal(baseline.mcpServers[0]?.name, 'global-mcp')

  assert.deepEqual(readGlobalConfigBundle({ env: { DSH_CONFIG_JSON: '{not json' } }).mcpServers, [])
  assert.deepEqual(readGlobalConfigBundle({ env: { DSH_CONFIG_JSON: '{"mcpServers":[{"name":"X","url":"ftp://a"}]}' } }).mcpServers, [])
  assert.deepEqual(readGlobalConfigBundle({}).mcpServers, [])
})

test('readResolvedConfig prefers the session bundle and falls back to the global baseline', async () => {
  const store = createStore(new Map([['conv-a', { metadata: {} }]]))
  const context = {
    store,
    env: { DSH_CONFIG_JSON: JSON.stringify({ instructions: '全局规则' }) },
  }

  const inherited = await readResolvedConfig(context, 'conv-a')
  assert.equal(inherited.source, 'global')
  assert.equal(inherited.bundle.instructions, '全局规则')

  await saveConfigBundle(context, 'conv-a', normalizeConfigBundle({ instructions: '会话规则' }))
  const overridden = await readResolvedConfig(context, 'conv-a')
  assert.equal(overridden.source, 'session')
  assert.equal(overridden.bundle.instructions, '会话规则')

  await resetConfigToGlobal(context, 'conv-a')
  const restored = await readResolvedConfig(context, 'conv-a')
  assert.equal(restored.source, 'global')
  assert.equal(restored.bundle.instructions, '全局规则')
})

test('readResolvedConfig reports empty when neither session nor baseline is configured', async () => {
  const resolved = await readResolvedConfig({ store: createStore() }, 'conv-none')
  assert.equal(resolved.source, 'empty')
  assert.equal(resolved.bundle.instructions, '')
})
