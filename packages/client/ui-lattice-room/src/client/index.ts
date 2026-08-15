/** Lattice room plugin, browser half. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
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

export const inject = ['slots', 'sessions', 'locale', 'connection']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-lattice-room: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle

  // Host apiproxy RPCs ride the fetch carrier exposed as connection.api.
  // The requested ctx.remote.lattice.groupDispatch surface would require a
  // Typert remote contribution for @deepseek-ai/dsh-host-apiproxy; until that
  // is generated and mounted by dsh-api-remotes, the same wire method is
  // reached through connection.api.lattice.groupDispatch.
  const currentSessionId = (): string | undefined => ctx.sessions.list.getSnapshot().current

  const openDispatchedChildren = async (
    parentSessionId: string,
    results: Array<{ childSessionId: string; provider: string }>,
  ): Promise<void> => {
    await ctx.sessions.refreshSubagents(parentSessionId)
    for (const result of results) {
      ctx.sessions.openSubagent({
        parentSessionId,
        childSessionId: result.childSessionId,
        mode: 'one-shot',
      })
    }
  }

  const injected = (): LatticeRoomInjected => ({
    listProviders: (): SubagentProvider[] => {
      // Official provider roster (the client cannot enumerate host providers yet).
      return ['claude-code', 'codex', 'acp', 'dsh-sdk', 'in-process', 'spawn', 'fork']
    },
    openSubagent: async (provider, name) => {
      const parentSessionId = currentSessionId()
      if (parentSessionId === undefined) return
      const response = await connection.api.lattice.groupDispatch({
        parentSessionId,
        items: [{ provider, name, prompt: '' }],
      })
      if (!response.result.ok) return
      await openDispatchedChildren(parentSessionId, response.result.value)
    },
    refreshSubagents: () => {
      const current = currentSessionId()
      if (current) void ctx.sessions.refreshSubagents(current)
    },
    sendTaskToMember: async (member, task) => {
      const parentSessionId = currentSessionId()
      if (parentSessionId === undefined) return `[${member.name}] no current session`
      const response = await connection.api.lattice.groupDispatch({
        parentSessionId,
        items: [{ provider: member.provider, name: member.name, prompt: task }],
      })
      if (!response.result.ok) {
        return `[${member.name}] dispatch failed: ${response.result.error.message}`
      }
      await openDispatchedChildren(parentSessionId, response.result.value)
      return `[${member.name}] dispatched to ${response.result.value.map(r => r.childSessionId).join(', ')}`
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
