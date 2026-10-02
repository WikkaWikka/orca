// The rules-release gate: the bundle a release would publish validates in the app's own loader,
// carries only agents whose transcripts the census replays, and only the protected workflow can
// publish it.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  BUNDLED_AGENT_STATE_RULES_VERSION,
  LIVE_UPDATABLE_AGENT_STATE_RULE_IDS,
  compareAgentStateRulesVersions as compareInApp,
  parseAgentStateRulesBundle
} from '../../src/main/runtime/agent-state-rules/agent-state-rules-bundle.ts'
import { BUNDLED_AGENT_STATE_RULE_FILES } from '../../src/main/runtime/agent-state-rules/agent-state-rules-catalog.ts'
import { agentStateRulesDownloadUrl } from '../../src/main/runtime/agent-state-rules/agent-state-rules-live-update.ts'
import {
  AGENT_STATE_RULES_ENGINE_VERSION,
  UNKNOWN_PANE_RULES_ID
} from '../../src/main/runtime/agent-state-rules/agent-state-rules-schema.ts'
import { CENSUS_TRANSCRIPTS } from '../../src/main/runtime/readiness-census-transcript-catalog.ts'
import {
  agentStateRulesGateTestFiles,
  assertLatestIsAppRelease,
  assertNewerThanPublished,
  buildAgentStateRulesBundle,
  compareAgentStateRulesVersions,
  promoteAgentStateRules,
  publishAgentStateRules
} from './agent-state-rules-bundle.mjs'
import { AGENT_STATE_RULES_ASSET, agentStateRulesTag } from './release-tag-patterns.mjs'

const REPO = 'stablyai/orca'
const NEXT = agentStateRulesTag(1, 'next')
const STABLE = agentStateRulesTag(1, 'stable')

describe('agent state rules bundle build', () => {
  it('builds a bundle the app accepts, under the bundled version and engine', () => {
    const { bundle, text } = buildAgentStateRulesBundle()
    const parsed = parseAgentStateRulesBundle(text, 'live-updatable')
    expect(parsed.ok).toBe(true)
    expect(bundle.engineVersion).toBe(AGENT_STATE_RULES_ENGINE_VERSION)
    expect(bundle.version).toBe(BUNDLED_AGENT_STATE_RULES_VERSION)
    expect(bundle.files).toEqual(
      BUNDLED_AGENT_STATE_RULE_FILES.filter((file) =>
        LIVE_UPDATABLE_AGENT_STATE_RULE_IDS.has(file.id)
      )
    )
    expect(bundle.bundledOnly).toBeUndefined()
    expect(buildAgentStateRulesBundle({ bundledOnly: true }).bundle.bundledOnly).toBe(true)
  })

  it('lets a rules release change only agents the readiness census replays', () => {
    const replayed = new Set(CENSUS_TRANSCRIPTS.flatMap((transcript) => transcript.agent ?? []))
    // Why unknown-pane: the census replays every recording on an agent-unknown pane too.
    replayed.add(UNKNOWN_PANE_RULES_ID)
    expect([...LIVE_UPDATABLE_AGENT_STATE_RULE_IDS].filter((id) => !replayed.has(id))).toEqual([])
  })

  it('agrees with the app on version order', () => {
    const versions = [
      '2026.10.01.1',
      '2026.10.1.2',
      '2026.9.30.9',
      '2026.10.01.10',
      '2027',
      '2026.10.01.1.0'
    ]
    for (const left of versions) {
      for (const right of versions) {
        expect(compareAgentStateRulesVersions(left, right)).toBe(compareInApp(left, right))
      }
    }
  })

  it('publishes to the exact URL the app fetches', () => {
    for (const channel of ['next', 'stable']) {
      expect(agentStateRulesDownloadUrl(channel)).toBe(
        `https://github.com/${REPO}/releases/download/${agentStateRulesTag(AGENT_STATE_RULES_ENGINE_VERSION, channel)}/${AGENT_STATE_RULES_ASSET}`
      )
    }
  })

  it('gates on the rule tests and every transcript replay', async () => {
    const files = await agentStateRulesGateTestFiles()
    expect(files).toContain('config/scripts/agent-state-rules-bundle.test.mjs')
    expect(files).toContain('src/main/runtime/agent-state-rules/agent-state-rules-bundle.test.ts')
    expect(files).toContain('src/main/runtime/readiness-census.test.ts')
    expect(files).toContain('src/main/runtime/readiness-census-transcripts-1.test.ts')
    expect(files).toContain('src/main/runtime/codex-header-readiness-transcripts.test.ts')
  })
})

describe('agent state rules publishing rules', () => {
  const at = (version) => JSON.stringify({ version })

  it.each([
    ['2026.10.02.1', null, true],
    ['2026.10.02.1', '2026.10.01.9', true],
    ['2026.10.02.1', '2026.10.02.1', false],
    ['2026.10.02.1', '2026.10.10.1', false]
  ])('publishes %s over %s: %s', (candidate, published, allowed) => {
    const check = () => assertNewerThanPublished(at(candidate), published && at(published))
    if (allowed) {
      expect(check).not.toThrow()
    } else {
      expect(check).toThrow('bump agent-state-rules-release.json')
    }
  })

  it.each([
    ['v1.4.2', true],
    ['v1.4.3-rc.0', false],
    [NEXT, false],
    ['mobile-v0.0.1', false]
  ])('accepts %s as Latest: %s', (tag, ok) => {
    const check = () => assertLatestIsAppRelease(tag)
    if (ok) {
      expect(check).not.toThrow()
    } else {
      expect(check).toThrow('not a stable desktop release')
    }
  })
})

/** A `gh` stand-in over an in-memory set of releases, recording each call. */
function fakeGh({ releases = {}, latest = 'v1.4.2' } = {}) {
  const calls = []
  const gh = (args) => {
    calls.push(args)
    const [group, verb, tag] = args
    if (group === 'api') {
      return { status: 0, stdout: `${latest}\n`, stderr: '' }
    }
    if (verb === 'view') {
      return tag in releases
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: 'release not found' }
    }
    if (verb === 'download') {
      const dir = args[args.indexOf('--dir') + 1]
      writeFileSync(join(dir, AGENT_STATE_RULES_ASSET), releases[tag])
    }
    if (verb === 'upload' || verb === 'create') {
      releases[tag] = readFileSync(args[3], 'utf8')
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { gh, calls, releases }
}

function candidateFile(version, engineVersion = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-state-rules-candidate-'))
  const path = join(dir, AGENT_STATE_RULES_ASSET)
  writeFileSync(path, `${JSON.stringify({ version, engineVersion, files: [] })}\n`)
  return path
}

describe('publishAgentStateRules', () => {
  it('creates the release as a prerelease that can never be Latest', () => {
    const fake = fakeGh()
    const file = candidateFile('2026.10.02.1')
    expect(
      publishAgentStateRules({ repo: REPO, tag: NEXT, file, target: 'abc123', gh: fake.gh })
    ).toBe('v1.4.2')
    const create = fake.calls.find((args) => args[1] === 'create')
    expect(create).toEqual(
      expect.arrayContaining(['--prerelease', '--latest=false', '--target', 'abc123'])
    )
    expect(fake.calls.at(-1)).toEqual(['api', `repos/${REPO}/releases/latest`, '--jq', '.tag_name'])
  })

  it('replaces the asset in place on an existing release, keeping the tag', () => {
    const fake = fakeGh({ releases: { [NEXT]: at('2026.10.01.1') } })
    publishAgentStateRules({
      repo: REPO,
      tag: NEXT,
      file: candidateFile('2026.10.02.1'),
      target: 'abc',
      gh: fake.gh
    })
    const verbs = fake.calls.map((args) => args.slice(0, 2).join(' '))
    expect(verbs).toEqual([
      'release view',
      'release download',
      'release upload',
      'release edit',
      'api repos/stablyai/orca/releases/latest'
    ])
    expect(fake.calls.find((args) => args[1] === 'upload')).toContain('--clobber')
    expect(fake.calls.find((args) => args[1] === 'edit')).toEqual(
      expect.arrayContaining(['--prerelease', '--latest=false'])
    )
    expect(JSON.parse(fake.releases[NEXT]).version).toBe('2026.10.02.1')
  })

  it('refuses a version that is not newer than the published one, uploading nothing', () => {
    const fake = fakeGh({ releases: { [NEXT]: at('2026.10.02.1') } })
    expect(() =>
      publishAgentStateRules({
        repo: REPO,
        tag: NEXT,
        file: candidateFile('2026.10.02.1'),
        target: 'abc',
        gh: fake.gh
      })
    ).toThrow('not newer')
    expect(fake.calls.some((args) => args[1] === 'upload')).toBe(false)
  })

  it('fails loudly when Latest is no longer the desktop app', () => {
    const fake = fakeGh({ latest: NEXT })
    expect(() =>
      publishAgentStateRules({
        repo: REPO,
        tag: NEXT,
        file: candidateFile('2026.10.02.1'),
        target: 'abc',
        gh: fake.gh
      })
    ).toThrow('not a stable desktop release')
  })

  it("refuses a tag outside the rules family, a misnamed asset or another engine's file", () => {
    const fake = fakeGh()
    expect(() =>
      publishAgentStateRules({
        repo: REPO,
        tag: 'v1.4.2',
        file: candidateFile('1'),
        target: 'abc',
        gh: fake.gh
      })
    ).toThrow('not an agent state rules tag')
    const misnamed = join(mkdtempSync(join(tmpdir(), 'agent-state-rules-misnamed-')), 'rules.json')
    writeFileSync(misnamed, at('1'))
    expect(() =>
      publishAgentStateRules({ repo: REPO, tag: NEXT, file: misnamed, target: 'abc', gh: fake.gh })
    ).toThrow('must be named')
    expect(() =>
      publishAgentStateRules({
        repo: REPO,
        tag: NEXT,
        file: candidateFile('2026.10.02.1', 2),
        target: 'abc',
        gh: fake.gh
      })
    ).toThrow('built for rules engine 2')
    expect(fake.calls).toEqual([])
  })

  it('promotes the identical next bytes to stable', () => {
    const nextText = `${JSON.stringify({ version: '2026.10.02.1', engineVersion: 1, files: [] }, null, 2)}\n`
    const fake = fakeGh({ releases: { [NEXT]: nextText, [STABLE]: at('2026.10.01.1') } })
    promoteAgentStateRules({
      repo: REPO,
      nextTag: NEXT,
      stableTag: STABLE,
      target: 'abc',
      gh: fake.gh
    })
    expect(fake.releases[STABLE]).toBe(nextText)
  })

  function at(version) {
    return JSON.stringify({ version })
  }
})

describe('agent state rules workflows', () => {
  const read = (name) => parse(readFileSync(`.github/workflows/${name}`, 'utf8'))
  const publish = read('agent-state-rules-publish.yml')

  it('publishes only on manual dispatch from main, in the protected environment', () => {
    expect(Object.keys(publish.on)).toEqual(['workflow_dispatch'])
    for (const name of ['publish-next', 'promote-stable']) {
      const job = publish.jobs[name]
      expect(job.environment).toBe('agent-state-rules')
      expect(job.permissions).toEqual({ contents: 'write' })
    }
    expect(publish.permissions).toEqual({ contents: 'read' })
    expect(publish.jobs.gate.if).toContain("github.ref == 'refs/heads/main'")
    expect(publish.jobs['promote-stable'].if).toContain("github.ref == 'refs/heads/main'")
    expect(publish.jobs['publish-next'].needs).toBe('gate')
  })

  it('is the only workflow that publishes rules releases', () => {
    const publishers = readdirSync('.github/workflows').filter((name) =>
      /agent-state-rules-bundle\.mjs (?:publish|promote)|release create agent-state-rules/.test(
        readFileSync(`.github/workflows/${name}`, 'utf8')
      )
    )
    expect(publishers).toEqual(['agent-state-rules-publish.yml'])
  })

  it('runs the same gate on pull requests and attaches the built bundle', () => {
    const check = read('agent-state-rules-check.yml')
    const steps = check.jobs.gate.steps
    expect(
      steps.some((step) => step.run?.includes('agent-state-rules-bundle.mjs gate-files'))
    ).toBe(true)
    expect(
      publish.jobs.gate.steps.some((step) =>
        step.run?.includes('agent-state-rules-bundle.mjs gate-files')
      )
    ).toBe(true)
    expect(steps.find((step) => step.uses?.startsWith('actions/upload-artifact'))?.with.name).toBe(
      'agent-state-rules'
    )
  })
})
