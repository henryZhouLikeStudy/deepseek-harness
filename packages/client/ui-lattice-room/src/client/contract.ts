/** Lattice room slot contracts. */
import type { SessionId, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { RoomMember, SubagentProvider, PendingChild } from './stores.ts'

/** Injected callbacks for the lattice room browser. */
export interface LatticeRoomInjected {
  listProviders: () => SubagentProvider[]
  openSubagent: (provider: SubagentProvider, name: string) => void
  refreshSubagents: () => void
  sendTaskToMember: (roomId: string, member: RoomMember, task: string) => Promise<{ text: string; children: PendingChild[] }>
  fetchChildResult: (parentSessionId: SessionId, childSessionId: SessionId) => Promise<string | undefined>
  openChildSession: (address: SubagentAddress) => void
}
