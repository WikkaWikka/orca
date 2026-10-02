import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

const { WORKTREE } = vi.hoisted(() => ({
  WORKTREE: {
    path: '/tmp/worktree-a',
    head: 'abc',
    branch: 'feature/launch-turn-start',
    isBare: false,
    isMainWorktree: false
  }
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([WORKTREE]),
  listWorktreesStrict: vi.fn().mockResolvedValue([WORKTREE])
}))

async function launchedCodex(rows: () => AgentStatusIpcPayload[]) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared store fixture implements only what a launch reads.
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    getAgentStatusSnapshot: rows
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-launch' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const { handle } = await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
    launchAgent: 'codex'
  })
  return { runtime, handle }
}

function workingRow(
  handle: string,
  at: number,
  explicitPromptStartedAt?: number
): AgentStatusIpcPayload {
  return {
    paneKey: 'launch-pane',
    terminalHandle: handle,
    state: 'working',
    prompt: 'the brief',
    agentType: 'codex',
    connectionId: null,
    receivedAt: at,
    stateStartedAt: at,
    ...(explicitPromptStartedAt !== undefined ? { explicitPromptStartedAt } : {})
  }
}

describe('observeTerminalLaunchTurnStart', () => {
  it('reads a Codex spinner title with no prompt hook as unobserved', async () => {
    const { runtime, handle } = await launchedCodex(() => [])
    const launchStartedAt = Date.now()
    runtime.onPtyData('pty-launch', '\x1b]0;Codex working\x07', Date.now())

    await expect(
      runtime.observeTerminalLaunchTurnStart(handle, { launchStartedAt, agent: 'codex' }, 300)
    ).resolves.toBe('unobserved')
  })

  it('reads a hook turn that carried no prompt as unobserved', async () => {
    let rows: AgentStatusIpcPayload[] = []
    const { runtime, handle } = await launchedCodex(() => rows)
    const launchStartedAt = Date.now() - 10
    rows = [workingRow(handle, Date.now())]

    await expect(
      runtime.observeTerminalLaunchTurnStart(handle, { launchStartedAt, agent: 'codex' }, 300)
    ).resolves.toBe('unobserved')
  })

  it('observes a prompt-carrying hook turn after the launch', async () => {
    let rows: AgentStatusIpcPayload[] = []
    const { runtime, handle } = await launchedCodex(() => rows)
    const launchStartedAt = Date.now() - 10
    rows = [workingRow(handle, Date.now(), Date.now())]

    await expect(
      runtime.observeTerminalLaunchTurnStart(handle, { launchStartedAt, agent: 'codex' }, 300)
    ).resolves.toBe('observed')
  })

  it('reports an agent with no settled turn-start signal as unsupported', async () => {
    const { runtime, handle } = await launchedCodex(() => [])

    await expect(
      runtime.observeTerminalLaunchTurnStart(
        handle,
        { launchStartedAt: Date.now(), agent: 'aider' },
        300
      )
    ).resolves.toBe('unsupported')
  })
})
