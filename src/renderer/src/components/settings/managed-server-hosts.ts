import type { SshConnectionState } from '../../../../shared/ssh-types'

/**
 * Whether an SSH host may run a managed server. Windows hosts wait for W4; a host that has not
 * reported its platform yet is offered, and the deploy itself refuses a Windows one.
 */
export function isManagedServerCapableHost(state: SshConnectionState | undefined): boolean {
  return state?.remotePlatform !== 'win32'
}

/** "Move to managed server" also needs the relay to answer for running terminals. */
export function canMoveHostToManagedServer(state: SshConnectionState | undefined): boolean {
  return (
    state?.status === 'connected' &&
    (state.remotePlatform === 'linux' || state.remotePlatform === 'darwin')
  )
}
