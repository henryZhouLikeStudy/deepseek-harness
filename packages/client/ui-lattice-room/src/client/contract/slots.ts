/**
 * Lattice room contracts. A room browser fills the sidebar shell's
 * `sidebar.latticeRooms` hole; each room is a group-chat surface over the
 * official subagent seam.
 */
import type { SubagentAddress, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentProvider, RoomMember, PendingChild } from '../stores.ts'
// Type-only: pull the sidebar owner SlotMap merges into this program.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Host actions the room browser drives (all pure callbacks). */
export interface LatticeRoomInjected {
  /** List registered subagent providers (contact roster). */
  listProviders: () => Promise<SubagentProvider[]>
  /** Refresh the subagent catalog. */
  refreshSubagents: () => void
  /**
   * Send a task to a room member, track the dispatched child sessions, and
   * return a dispatch status string. The final assistant output is streamed
   * back separately via {@link fetchChildResult}.
   */
  sendTaskToMember: (roomId: string, member: RoomMember, task: string) => Promise<{
    text: string
    children: PendingChild[]
    childSessionId?: SessionId
  }>
  /**
   * Read a finished child's transcript and extract its final assistant text.
   * Returns undefined when the child produced no text output.
   */
  fetchChildResult: (parentSessionId: SessionId, childSessionId: SessionId) => Promise<string | undefined>
  /** Open a child session from a subagent address. */
  openChildSession: (address: SubagentAddress) => void
  /**
   * Relay a message from one child session to another under the current
   * parent session.
   */
  relay: (fromChildSessionId: SessionId, toChildSessionId: SessionId, content: string) => Promise<boolean>
}

export type LatticeRoomProps =
  PropsRuntime<'sidebar.latticeRooms'>
  & PropsStore<ReturnType<typeof import('../stores.js').createLatticeRoomStore>>
  & LatticeRoomInjected
  & PropsLocale<'lattice-room'>
