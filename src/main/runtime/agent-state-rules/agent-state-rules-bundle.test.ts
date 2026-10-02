import { describe, expect, it } from 'vitest'
import {
  AGENT_STATE_RULES_BUNDLE_MAX_BYTES,
  LIVE_UPDATABLE_AGENT_STATE_RULE_IDS,
  compareAgentStateRulesVersions,
  parseAgentStateRulesBundle
} from './agent-state-rules-bundle'
import { BUNDLED_AGENT_STATE_RULE_FILES } from './agent-state-rules-catalog'

function file(id: string): Record<string, unknown> {
  const found = BUNDLED_AGENT_STATE_RULE_FILES.find((candidate) => candidate.id === id)
  return structuredClone({ ...found })
}

function bundle(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '2026.10.2.1',
    engineVersion: 1,
    files: [file('claude')],
    ...overrides
  })
}

function rejection(text: string, scope: 'live-updatable' | 'any-agent' = 'live-updatable') {
  const result = parseAgentStateRulesBundle(text, scope)
  return result.ok ? null : result.error
}

describe('agent state rules bundle', () => {
  it('accepts a live-updatable file and carries the bundledOnly flag', () => {
    const result = parseAgentStateRulesBundle(bundle({ bundledOnly: true }), 'live-updatable')
    expect(result).toMatchObject({
      ok: true,
      bundle: { version: '2026.10.2.1', bundledOnly: true }
    })
  })

  it.each([
    ['an unknown top-level field', bundle({ signature: 'x' }), 'Unrecognized key'],
    ['a version that is not dotted numbers', bundle({ version: '2026-10-02' }), 'dotted numbers'],
    ['a missing version', bundle({ version: undefined }), 'version'],
    ['another engine', bundle({ engineVersion: 2 }), 'built for rules engine 2'],
    [
      'a file with a misspelled field',
      bundle({ files: [{ ...file('claude'), rule: [] }] }),
      'agent state rules file 0'
    ],
    ['two files for one agent', bundle({ files: [file('claude'), file('claude')] }), 'two files'],
    ['too many files', bundle({ files: Array.from({ length: 65 }, () => file('claude')) }), '64'],
    ['an agent with no transcript suite', bundle({ files: [file('gemini')] }), 'gemini']
  ])('rejects %s', (_label, text, error) => {
    expect(rejection(text)).toContain(error)
  })

  it('rejects text over the size cap before parsing it', () => {
    expect(rejection(`${bundle()}${' '.repeat(AGENT_STATE_RULES_BUNDLE_MAX_BYTES)}`)).toBe(
      `larger than ${AGENT_STATE_RULES_BUNDLE_MAX_BYTES} bytes`
    )
  })

  it('lets a local override carry any agent', () => {
    expect(rejection(bundle({ files: [file('gemini')] }), 'any-agent')).toBeNull()
  })

  it('names only agents that have a bundled rule file', () => {
    const bundled = new Set<string>(BUNDLED_AGENT_STATE_RULE_FILES.map((rules) => rules.id))
    expect([...LIVE_UPDATABLE_AGENT_STATE_RULE_IDS].filter((id) => !bundled.has(id))).toEqual([])
  })

  it.each([
    ['2026.10.01.1', '2026.9.30.4', 1],
    ['2026.10.01.1', '2026.10.1.1', 0],
    ['2026.10.01.1', '2026.10.01.1.0', 0],
    ['2026.10.01.2', '2026.10.01.10', -1],
    ['2027', '2026.12.31.9', 1]
  ])('compares %s to %s numerically', (left, right, expected) => {
    expect(compareAgentStateRulesVersions(left, right)).toBe(expected)
  })
})
