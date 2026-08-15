import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { RpcId } from '../src/api/rpc.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const sid = (value: string): SessionId => value as SessionId
const PARENT = sid('parent')
const CHILD = sid('child')
const OTHER = sid('other')

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('lattice-rpc'), payload }
}

function bench(options: {
  providers?: string[]
  entries?: object[]
  listError?: Error
  followupError?: Error
  startContinuableResult?: { childId: SessionId; messageId: string }
  startContinuableError?: Error
  startResult?: { id: SessionId }
  startError?: Error
} = {}) {
  const parent = { id: PARENT }
  const listChildren = vi.fn(() => options.listError === undefined
    ? Promise.resolve(options.entries ?? [{
      kind: 'child', id: CHILD, mode: 'continuable', label: 'worker',
      activity: 'inactive', hasChildren: false,
    }])
    : Promise.reject(options.listError))
  const followup = vi.fn((): Promise<string> => options.followupError === undefined
    ? Promise.resolve('message-1')
    : Promise.reject(options.followupError))
  const startContinuable = vi.fn((): Promise<{ childId: SessionId; messageId: string }> => options.startContinuableError === undefined
    ? Promise.resolve(options.startContinuableResult ?? { childId: sid('new-child'), messageId: 'message-1' })
    : Promise.reject(options.startContinuableError))
  const start = vi.fn((): Promise<{ id: SessionId }> => options.startError === undefined
    ? Promise.resolve(options.startResult ?? { id: sid('new-run') })
    : Promise.reject(options.startError))
  const ctx = new Context()
  ctx.provide('agents', { get: (id: SessionId) => id === PARENT ? parent : undefined })
  ctx.provide('userQuestions', { registerProvider: () => () => {} })
  ctx.provide('subagents', {
    list: () => options.providers ?? ['spawn'],
    listChildren,
    followup,
    startContinuable,
    start,
  })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp',
  })
  return { api, listChildren, followup, startContinuable, start, parent }
}

describe('lattice groupDispatch', () => {
  it('rejects duplicate childSessionId before starting any child', async () => {
    const { api, listChildren, startContinuable, followup } = bench()
    const response = await api.lattice.groupDispatch(request({
      parentSessionId: PARENT,
      items: [
        { provider: 'spawn', name: 'a', prompt: 'go', childSessionId: CHILD },
        { provider: 'spawn', name: 'b', prompt: 'go too', childSessionId: CHILD },
      ],
    }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'bad-request', message: 'duplicate childSessionId' },
    })
    expect(listChildren).not.toHaveBeenCalled()
    expect(startContinuable).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })

  it('does not start children when preflight finds an invalid continuation target', async () => {
    const { api, listChildren, startContinuable, followup } = bench({
      entries: [{
        kind: 'child', id: CHILD, mode: 'continuable', label: 'worker',
        activity: 'inactive', hasChildren: false,
      }],
    })
    const response = await api.lattice.groupDispatch(request({
      parentSessionId: PARENT,
      items: [
        { provider: 'spawn', name: 'a', prompt: 'go', childSessionId: CHILD },
        { provider: 'spawn', name: 'b', prompt: 'go too', childSessionId: OTHER },
      ],
    }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'subagent-not-found',
        details: { parentSessionId: PARENT, childSessionId: OTHER },
      },
    })
    expect(listChildren).toHaveBeenCalledWith(PARENT, undefined)
    expect(startContinuable).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })

  it('maps followup errors through subagentPromptError with provider attribution', async () => {
    const { api, followup } = bench({
      followupError: new SubagentError('not resumable', 'NOT_RESUMABLE'),
    })
    const response = await api.lattice.groupDispatch(request({
      parentSessionId: PARENT,
      items: [
        { provider: 'spawn', name: 'a', prompt: 'go', childSessionId: CHILD },
      ],
    }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'subagent-not-resumable',
        details: { childSessionId: CHILD, provider: 'spawn' },
      },
    })
    expect(followup).toHaveBeenCalledOnce()
  })
})

describe('lattice relay', () => {
  it('rejects relaying a child to itself', async () => {
    const { api, listChildren, followup } = bench()
    const response = await api.lattice.relay(request({
      parentSessionId: PARENT,
      fromChildSessionId: CHILD,
      toChildSessionId: CHILD,
      content: 'self',
    }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'lattice-self-relay', message: 'cannot relay a child to itself' },
    })
    expect(listChildren).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })
})
