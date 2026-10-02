// A send the host provably never recorded goes back to the composer and is said once beside it,
// instead of staying in the transcript with a Retry. A send in doubt never goes back.

// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionWireRefusalCode } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

const mocks = vi.hoisted(() => ({
  call: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  appendNativeChatAttachmentCache,
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache
} from './use-native-chat-composer-attachments'
import { commitStructuredAgentSessionOutbox } from './structured-agent-session-outbox-storage'

const TARGET = { kind: 'local' } as const
const COMPOSER = 'composer-1'

function refused(code: AgentSessionWireRefusalCode, details?: Record<string, unknown>) {
  return { ok: false, refusal: { code, message: code, ...(details ? { details } : {}) } }
}

afterEach(cleanup)

// Each test its own chat: the outbox store outlives a test, and a leftover entry would drain here.
let chat = 0
const sessionId = () => `session-${chat}`

beforeEach(() => {
  chat += 1
  vi.clearAllMocks()
  mocks.call.mockReset()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  clearNativeChatAttachmentCacheForTests()
  let uuid = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    uuid += 1
    return `11111111-1111-4111-8111-${uuid.toString(16).padStart(12, '0')}`
  })
})

function renderOutbox(
  composerScopeKey: string | null = COMPOSER,
  submissions: readonly AgentJournalSubmission[] = []
) {
  return renderHook(
    (props: { submissions: readonly AgentJournalSubmission[] }) =>
      useStructuredAgentSessionOutbox({
        sessionId: sessionId(),
        target: TARGET,
        fence: 1,
        submissions: props.submissions,
        agentName: 'Claude',
        ...(composerScopeKey ? { composerScopeKey } : {})
      }),
    { initialProps: { submissions } }
  )
}

describe('a send the host refused before recording it', () => {
  it.each([
    [
      'a settled refusal',
      refused('agent_session_operation_conflict'),
      'Your message was not sent.'
    ],
    [
      'an exited owner',
      refused('agent_session_ownership_unknown', { ownerVerdict: 'exited' }),
      'Your message was not sent. Send it again.'
    ]
  ])(
    'leaves the transcript and goes back to the composer after %s',
    async (_label, answer, said) => {
      mocks.call.mockResolvedValueOnce(answer)
      const { result } = renderOutbox()

      act(() => {
        expect(
          result.current.send('fix the build', [{ path: '/tmp/shot.png', previewUri: 'blob:1' }])
        ).toBe(true)
      })

      await waitFor(() => expect(result.current.outbox).toEqual([]))
      expect(mocks.call).toHaveBeenCalledOnce()
      expect(readNativeChatDraftCache(COMPOSER)).toBe('fix the build')
      expect(readNativeChatAttachmentCache(COMPOSER).map((image) => image.path)).toEqual([
        '/tmp/shot.png'
      ])
      // Said once, beside the composer: no row keeps it, so nothing says it twice.
      expect(result.current.error).toBe(said)
    }
  )

  it('clears the line once the user sends again', async () => {
    mocks.call
      .mockResolvedValueOnce(refused('agent_session_operation_conflict'))
      .mockReturnValueOnce(new Promise(() => {}))
    const { result } = renderOutbox()

    act(() => {
      result.current.send('fix the build')
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    act(() => {
      result.current.send('fix the build')
    })
    expect(result.current.error).toBeNull()
  })

  // Never mixed into what the user typed since: the row keeps it, with its Retry.
  it.each([
    {
      holds: 'text',
      fill: () => writeNativeChatDraftCache(COMPOSER, 'typed meanwhile'),
      draft: 'typed meanwhile',
      images: 0
    },
    {
      holds: 'an image',
      fill: () => appendNativeChatAttachmentCache(COMPOSER, [{ id: 'img-1', path: '/tmp/a.png' }]),
      draft: '',
      images: 1
    }
  ])(
    'keeps it in the transcript when the composer holds $holds',
    async ({ fill, draft, images }) => {
      mocks.call.mockResolvedValueOnce(refused('agent_session_operation_conflict'))
      fill()
      const { result } = renderOutbox()

      act(() => {
        result.current.send('fix the build')
      })

      await waitFor(() => expect(result.current.outbox[0]?.state).toBe('rejected'))
      expect(readNativeChatDraftCache(COMPOSER)).toBe(draft)
      expect(readNativeChatAttachmentCache(COMPOSER)).toHaveLength(images)
      expect(result.current.error).toBeNull()
    }
  )

  it('keeps it in the transcript with its Retry where no composer can take it back', async () => {
    mocks.call.mockResolvedValueOnce(refused('agent_session_operation_conflict'))
    const { result } = renderOutbox(null)

    act(() => {
      result.current.send('fix the build')
    })

    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('rejected'))
    expect(result.current.error).toBeNull()
  })
})

describe('a send the host may have recorded', () => {
  it('never goes back to the composer after a refusal that proves nothing', async () => {
    mocks.call.mockResolvedValueOnce(refused('agent_session_conflict'))
    const { result } = renderOutbox()

    act(() => {
      result.current.send('fix the build')
    })

    await waitFor(() => expect(result.current.outbox[0]?.lastFailure?.kind).toBe('refused'))
    expect(readNativeChatDraftCache(COMPOSER)).toBe('')
  })

  it('never goes back to the composer when its delivery is in doubt', async () => {
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    const { result } = renderOutbox()

    act(() => {
      result.current.send('fix the build')
    })

    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))
    expect(readNativeChatDraftCache(COMPOSER)).toBe('')
    expect(result.current.error).toBeNull()
  })

  it('leaves the outbox once the host says it lost track across a restart, said once', async () => {
    const doubted: StructuredAgentSessionOutboxEntry = {
      clientMessageId: 'op-doubted',
      sessionId: sessionId(),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fix the build' }] },
      previewUris: [],
      state: 'unconfirmed',
      queuedAt: 1,
      lastAttemptAt: 1,
      retryAfterUnknownSubmittedAt: null
    }
    commitStructuredAgentSessionOutbox(sessionId(), [doubted])
    const { result, rerender } = renderOutbox()
    expect(result.current.outbox).toHaveLength(1)

    rerender({
      submissions: [
        {
          clientMessageId: 'op-doubted',
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'unknown',
          providerItemId: null,
          reason: 'host_restarted_before_acknowledgement',
          submittedAt: 1,
          resolvedAt: 2,
          recovered: true
        }
      ]
    })

    // The journal's row keeps the message in the chat; nothing here waits on it or resends it.
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(result.current.error).toBe(
      "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
    )
    expect(readNativeChatDraftCache(COMPOSER)).toBe('')
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
