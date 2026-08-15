/** Lattice room plugin, browser half. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { LatticeRoomInjected } from './contract/slots.ts'
import { createLatticeRoomStore, type SubagentProvider } from './stores.ts'
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
      // Official provider roster (the client cannot enumerate host providers yet).
      return ['claude-code', 'codex', 'acp', 'dsh-sdk', 'in-process', 'spawn', 'fork']
    },
    openSubagent: (_provider, _name) => {
      // Real creation-by-provider needs a host-side RPC; no-op until that lands.
    },
    refreshSubagents: () => {
      const current = ctx.sessions.list.getSnapshot().current
      if (current) void ctx.sessions.refreshSubagents(current)
    },
    sendTaskToMember: async (member, task) => {
      // Real dispatch needs the host-side group-dispatch RPC; return a queued status for now.
      return `[${member.name}] queued: ${task}`
    },
    openChildSession: (address) => {
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
