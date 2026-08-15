/** Lattice room plugin, browser half. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, ContentBlock, SessionEvent } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { LatticeRoomInjected } from './contract/slots.ts'
import { createLatticeRoomStore, type SubagentProvider, type PendingChild } from './stores.ts'
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

/**
 * Apply the same selection rule as @deepseek-ai/dsh-subagent/assistant-output:
 * prefer the last non-empty assistant/message, else fall back to accumulated
 * text-delta chunks. This client-side copy avoids adding a subagent dependency
 * to the browser plugin.
 * @param events - child-owned session events from subagent.history.
 * @returns selected output, or undefined when the child produced none.
 */
function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined {
  let message: ContentBlock[] | undefined
  const partial: string[] = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const content = event.data.message.content
      if (content.length > 0) message = content
    } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      const text = event.data.chunk.text
      if (text.length > 0) partial.push(text)
    }
  }
  if (message !== undefined) return message
  const text = partial.join('')
  return text.length > 0 ? [{ type: 'text', text }] : undefined
}

/**
 * Render selected content blocks as plain text for the room transcript.
 * Text and reasoning blocks emit their text; other block types emit a compact
 * placeholder so the reader knows non-text output was produced.
 * @param blocks - selected assistant output blocks.
 * @returns plain text suitable for a room message.
 */
function contentBlocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'text' || b.type === 'reasoning') return b.text
      if (b.type === 'tool-call') return `[tool-call: ${b.name}]`
      if (b.type === 'tool-result') return '[tool-result]'
      if (b.type === 'image') return '[image]'
      return `[${(b as { type: string }).type}]`
    })
    .join('')
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-lattice-room: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle

  // Host apiproxy RPCs ride the fetch carrier exposed as connection.api.
  // The requested ctx.remote.lattice.groupDispatch surface would require a
  // Typert remote contribution for @deepseek-ai/dsh-host-apiproxy; until that
  // is generated and mounted by dsh-api-remotes, the same wire method is
  // reached through connection.api.lattice.groupDispatch.
  const currentSessionId = (): SessionId | undefined => ctx.sessions.list.getSnapshot().current

  const store = createLatticeRoomStore()

  const openDispatchedChildren = async (
    parentSessionId: SessionId,
    results: Array<{ childSessionId: SessionId; provider: string }>,
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
    sendTaskToMember: async (roomId, member, task) => {
      const parentSessionId = currentSessionId()
      if (parentSessionId === undefined) return { text: `[${member.name}] no current session`, children: [] }
      const response = await connection.api.lattice.groupDispatch({
        parentSessionId,
        items: [{ provider: member.provider, name: member.name, prompt: task }],
      })
      if (!response.result.ok) {
        return { text: `[${member.name}] dispatch failed: ${response.result.error.message}`, children: [] }
      }
      const children: PendingChild[] = response.result.value.map((r) => ({
        memberName: member.name,
        childSessionId: r.childSessionId,
        provider: r.provider,
        parentSessionId,
      }))
      await openDispatchedChildren(parentSessionId, response.result.value)
      return { text: `[${member.name}] dispatched to ${response.result.value.map(r => r.childSessionId).join(', ')}`, children }
    },
    fetchChildResult: async (parentSessionId, childSessionId) => {
      const response = await connection.api.subagents.history({
        parentSessionId,
        childSessionId,
        mode: 'one-shot',
      })
      if (!response.result.ok) {
        throw new Error(response.result.error.message)
      }
      const output = finalAssistantOutput(response.result.value.events.map(e => e.event))
      return output === undefined ? undefined : contentBlocksToText(output)
    },
    openChildSession: (address) => {
      ctx.sessions.openSubagent(address)
    },
  })

  ctx.slots.inject('sidebar.latticeRooms', () => ctx.slots.register(
    {
      name: 'sidebar.latticeRooms',
      store,
      inject: injected,
      locale: NS
    },
    LatticeRoomBrowser,
  ))
}
