/** Lattice room slot contracts. */
import type { SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { RoomMember, SubagentProvider } from './stores.ts'

/** Injected callbacks for the lattice room browser. */
export interface LatticeRoomInjected {
  listProviders: () => SubagentProvider[]
  openSubagent: (provider: SubagentProvider, name: string) => void
  refreshSubagents: () => void
  sendTaskToMember: (member: RoomMember, task: string) => Promise<string>
  openChildSession: (address: SubagentAddress) => void
}
