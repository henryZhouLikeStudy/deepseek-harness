/**
 * Lattice domain contract: host-side group dispatch of subagent tasks.
 * The client names a parent session and a roster of provider/name/prompt items;
 * the host starts each item as a continuable or one-shot subagent run under the
 * same live parent and returns the published child session ids.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One item in a group dispatch: provider, label, prompt text, and optional existing child to reuse. */
export interface LatticeDispatchItem {
  /** Registered subagent provider name (e.g. `spawn`, `fork`, `acp`). */
  provider: string
  /** Display label persisted with the child session. */
  name: string
  /** Prompt delivered as a single user text block. */
  prompt: string
  /** Existing durable child session id to reuse for a continuable follow-up. */
  childSessionId?: SessionId
}

/** One published child returned from a group dispatch. */
export interface LatticeDispatchResult {
  /** The child session id; for local one-shot runs this equals the published run id. */
  childSessionId: SessionId
  /** The provider that accepted and published this child. */
  provider: string
  /** Whether the dispatch created or reused a continuable child, or fell back to one-shot. */
  mode: 'one-shot' | 'continuable'
}

/** Result of relaying one message between child sessions. */
export interface LatticeRelayResult {
  /** The durable message id assigned to the relayed message. */
  messageId: string
}

/** Lattice-domain unary methods (the map keys lattice.* of RpcMethodMap). */
export interface LatticeApi {
  /**
   * Enumerate the names of subagent providers currently registered with the
   * host. The roster is dynamic: providers are added or removed as the host
   * composition changes.
   */
  listProviders(
    request: RpcRequest<{}>,
  ): Promise<RpcResponse<string[]>>

  /**
   * Start a batch of subagent runs under one live parent session. Each item
   * selects its provider by name and may reuse an existing continuable child;
   * failures fail the whole batch so the caller receives either a complete
   * roster or a typed error.
   */
  groupDispatch(
    request: RpcRequest<{ parentSessionId: SessionId; items: LatticeDispatchItem[] }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<LatticeDispatchResult[]>>

  /**
   * Relay a text message from one child session to another under the same live
   * parent. The target must be a continuable direct child of the parent; the
   * message is delivered as a coordinator relay so the recipient can attribute
   * it to the sender session.
   */
  relay(
    request: RpcRequest<{ parentSessionId: SessionId; fromChildSessionId: SessionId; toChildSessionId: SessionId; content: string }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<LatticeRelayResult>>
}
