// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcadManagedConversionPreview } from '../../../../shared/orcad-managed-runtime'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { MoveToManagedServerDialog } from './MoveToManagedServerDialog'
import {
  redactRuntimeEnvironment,
  createEnvironmentFromPairingOffer
} from '../../../../shared/runtime-environments'
import { canMoveHostToManagedServer, isManagedServerCapableHost } from './managed-server-hosts'

vi.mock('../ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

function createEnvironment() {
  return redactRuntimeEnvironment(
    createEnvironmentFromPairingOffer({
      id: 'env-1',
      name: 'Builder',
      now: 1,
      offer: { v: 2, endpoint: 'ws://127.0.0.1:1', deviceToken: 't', publicKeyB64: 'k' }
    })
  )
}

const target: SshTarget = { id: 'ssh-1', label: 'Builder', host: 'b', port: 22, username: 'dev' }

function preview(
  overrides: Partial<OrcadManagedConversionPreview> = {}
): OrcadManagedConversionPreview {
  return {
    sshTargetId: 'ssh-1',
    targetLabel: 'Builder',
    moves: {
      repositories: 2,
      projectGroups: 1,
      folderWorkspaces: 1,
      automations: 0,
      workspaceSession: true
    },
    blockers: [],
    terminals: { verdict: 'exited' },
    ...overrides
  }
}

function api(next: OrcadManagedConversionPreview): ManagedOrcadPreloadApi {
  const unused = vi.fn(async () => {
    throw new Error('not used by the move dialog')
  })
  return {
    deploy: unused,
    getStatus: unused,
    update: unused,
    rollback: unused,
    recover: unused,
    stop: unused,
    cancelStop: unused,
    linkSshAccess: unused,
    unlinkSshAccess: unused,
    previewConversion: vi.fn(async () => next),
    convertSshHost: vi.fn(async () => ({
      outcome: 'converted' as const,
      environment: createEnvironment(),
      migrationId: 'm-1'
    })),
    listPendingMigrations: vi.fn(async () => [])
  }
}

async function render(managed: ManagedOrcadPreloadApi): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <MoveToManagedServerDialog
        api={managed}
        target={target}
        onClose={() => {}}
        onFinished={() => {}}
      />
    )
  })
  return container
}

const moveButton = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === 'Move host')

describe('Move to managed server', () => {
  it('summarizes what moves and only enables the move after the terminal confirmation', async () => {
    const managed = api(preview())
    const container = await render(managed)
    expect(container.textContent).toContain('Repositories: 2')
    expect(container.textContent).toContain('Folder workspaces: 1')
    expect(moveButton(container)?.disabled).toBe(true)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click()
    })
    expect(moveButton(container)?.disabled).toBe(false)
    await act(async () => {
      moveButton(container)?.click()
    })
    expect(managed.convertSshHost).toHaveBeenCalledWith({ sshTargetId: 'ssh-1', name: 'Builder' })
    expect(container.textContent).toContain('Moved.')
  })

  it('names each blocker and keeps the move disabled', async () => {
    const container = await render(
      api(
        preview({
          blockers: [
            {
              code: 'orcad_migration_dependency_unverifiable',
              category: 'live-or-unverifiable',
              sources: ['automation']
            }
          ],
          terminals: { verdict: 'unverifiable', ptyIds: ['p'], reason: 'the relay did not answer' }
        })
      )
    )
    expect(container.textContent).toContain('could not read its saved automations, so')
    expect(container.textContent).toContain('the relay did not answer')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click()
    })
    expect(moveButton(container)?.disabled).toBe(true)
  })
})

describe('managed server host eligibility', () => {
  it('hides Windows hosts and only offers a move on a connected macOS or Linux host', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: eligibility reads only status and remotePlatform.
    const state = (status: string, remotePlatform: string) => ({ status, remotePlatform }) as never
    expect(isManagedServerCapableHost(state('connected', 'win32'))).toBe(false)
    expect(isManagedServerCapableHost(undefined)).toBe(true)
    expect(canMoveHostToManagedServer(state('connected', 'linux'))).toBe(true)
    expect(canMoveHostToManagedServer(state('connected', 'win32'))).toBe(false)
    expect(canMoveHostToManagedServer(state('disconnected', 'linux'))).toBe(false)
  })
})
