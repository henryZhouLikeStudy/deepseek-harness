/** Lattice room plugin, browser half. */
import type { ClientContext, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { LatticeRoomInjected } from './contract/slots.ts'
import { createLatticeRoomStore, type SubagentProvider, type RoomMember } from './stores.ts'
import { LatticeRoomBrowser } from './LatticeRoomBrowser.tsx'
import { en, zh, type LatticeRoomKey, NS } from './locales.ts'

export type { LatticeRoomProps, LatticeRoomInjected } from './contract/slots.ts'
export type { LatticeRoomKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'lattice-room': LatticeRoomKey
  }
}

export const inject = ['slots', 'sessions', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-lattice-room: dictionaries')

  const injected = (): LatticeRoomInjected => ({
    listProviders: (): SubagentProvider[] => {
      // Official provider list from the subagent system documentation
      return ['claude-code', 'codex', 'acp', 'dsh-sdk', 'in-process', 'spawn', 'fork']
    },
    openSubagent: (provider: SubagentProvider, name: string) => {
      // Open/refresh a subagent via ctx.sessions
      const address: SubagentAddress = { provider, name, mode: 'continuable' }
      ctx.sessions.openSubagent(address)
    },
    refreshSubagents: () => {
      // Refresh subagent catalog for the current session
      const currentSessionId = ctx.sessions.list.getSnapshot().current
      if (currentSessionId) {
        void ctx.sessions.refreshSubagents(currentSessionId)
      }
    },
    sendTaskToMember: async (member: RoomMember, task: string): Promise<string> => {
      // Open/refresh the member's subagent and return a status message
      const address: SubagentAddress = { provider: member.provider, name: member.name, mode: 'continuable' }
      ctx.sessions.openSubagent(address)
      void ctx.sessions.refreshSubagents(ctx.sessions.list.getSnapshot().current ?? '')
      return `Task sent to ${member.name} (${member.provider})`
    },
    openChildSession: (address: SubagentAddress) => {
      // Open a child session from a subagent address
      ctx.sessions.openSubagent(address)
    },
  })

  ctx.slots.inject('sidebar.latticeRooms', () => ctx.slots.register(
    {
      name: 'sidebar.latticeRooms',
      store: createLatticeRoomStore(),
      inject: injected,
      locale: NS
    },
    LatticeRoomBrowser,
  ))
}
