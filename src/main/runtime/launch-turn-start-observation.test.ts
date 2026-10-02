import { describe, expect, it } from 'vitest'
import {
  LAUNCH_HOOK_SILENCE_MS,
  observeLaunchTurnStart,
  type LaunchTurnStartProbe
} from './launch-turn-start-observation'

/** A hook proof that never arrives, as when an agent's turn carried no prompt the hook saw. */
function pendingHookTurn(signal: AbortSignal): Promise<'unobserved'> {
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve('unobserved')))
}

function probe(overrides: Partial<LaunchTurnStartProbe>): LaunchTurnStartProbe {
  return {
    observeHookTurn: pendingHookTurn,
    hookReachedPane: () => false,
    readWorkingSequence: () => 0,
    launchRecorded: () => true,
    readForeground: async () => 'agent',
    ...overrides
  }
}

describe('observeLaunchTurnStart', () => {
  it('keeps waiting on the hook while hook events reach the pane', async () => {
    await expect(
      observeLaunchTurnStart(probe({ hookReachedPane: () => true }), {
        launchStartedAt: Date.now() - LAUNCH_HOOK_SILENCE_MS,
        timeoutMs: 600
      })
    ).resolves.toBe('unobserved')
  })

  // Why: hooks not installed on a host leave the pane silent; the launch is judged as main judged it.
  it('judges a launch whose hooks stayed silent by the agent holding its terminal', async () => {
    await expect(
      observeLaunchTurnStart(probe({}), {
        launchStartedAt: Date.now() - LAUNCH_HOOK_SILENCE_MS,
        timeoutMs: 600
      })
    ).resolves.toBe('unsupported')
  })

  it('does not judge a launch by its own evidence before its hooks had time to report', async () => {
    await expect(
      observeLaunchTurnStart(probe({}), { launchStartedAt: Date.now(), timeoutMs: 600 })
    ).resolves.toBe('unobserved')
  })

  it('takes the hook proof over the launch evidence', async () => {
    await expect(
      observeLaunchTurnStart(probe({ observeHookTurn: async () => 'observed' }), {
        launchStartedAt: Date.now(),
        timeoutMs: 600
      })
    ).resolves.toBe('observed')
  })

  it('reports an exit only for a launch it saw recorded and then finished', async () => {
    let recorded = true
    setTimeout(() => {
      recorded = false
    }, 100)
    await expect(
      observeLaunchTurnStart(
        probe({ launchRecorded: () => recorded, readForeground: async () => 'shell' }),
        { launchStartedAt: Date.now(), timeoutMs: 600 }
      )
    ).resolves.toBe('exited')
    await expect(
      observeLaunchTurnStart(
        probe({ launchRecorded: () => false, readForeground: async () => 'shell' }),
        { launchStartedAt: Date.now(), timeoutMs: 600 }
      )
    ).resolves.toBe('unobserved')
  })
})
