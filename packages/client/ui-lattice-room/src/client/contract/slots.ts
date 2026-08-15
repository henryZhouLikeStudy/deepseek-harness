/**
 * Lattice room contracts. A room browser fills the sidebar shell's
 * `sidebar.latticeRooms` hole; each room is a group-chat surface over the
 * official subagent seam.
 */
import type { SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentProvider, RoomMember } from '../stores.ts'
// Type-only: pull the sidebar owner SlotMap merges into this program.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Host actions the room browser drives (all pure callbacks). */
export interface LatticeRoomInjected {
  /** List registered subagent providers (contact roster). */
  listProviders: () => SubagentProvider[]
  /** Open a subagent by provider and name. */
  openSubagent: (provider: SubagentProvider, name: string) => void
  /** Refresh the subagent catalog. */
  refreshSubagents: () => void
  /** Send a task to a room member and return result. */
  sendTaskToMember: (member: RoomMember, task: string) => Promise<string>
  /** Open a child session from a subagent address. */
  openChildSession: (address: SubagentAddress) => void
}

export type LatticeRoomProps =
  PropsRuntime<'sidebar.latticeRooms'>
  & PropsStore<ReturnType<typeof import('../stores.js').createLatticeRoomStore>>
  & LatticeRoomInjected
  & PropsLocale<'lattice-room'>
