/**
 * Lattice domain contract: host-side group dispatch of one-shot subagent tasks.
 * The client names a parent session and a roster of provider/name/prompt items;
 * the host starts each item as a one-shot subagent run under the same live parent
 * and returns the published child session ids.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One item in a group dispatch: which provider to use, how to label it, and the prompt text. */
export interface LatticeDispatchItem {
  /** Registered subagent provider name (e.g. `spawn`, `fork`, `acp`). */
  provider: string
  /** Display label persisted with the child session. */
  name: string
  /** Prompt delivered as a single user text block. */
  prompt: string
}

/** One published child returned from a group dispatch. */
export interface LatticeDispatchResult {
  /** The child session id; for local one-shot runs this equals the published run id. */
  childSessionId: SessionId
  /** The provider that accepted and published this child. */
  provider: string
}

/** Lattice-domain unary methods (the map keys lattice.* of RpcMethodMap). */
export interface LatticeApi {
  /**
   * Start a batch of one-shot subagent runs under one live parent session.
   * Each item selects its provider by name; failures fail the whole batch so
   * the caller receives either a complete roster or a typed error.
   */
  groupDispatch(
    request: RpcRequest<{ parentSessionId: SessionId; items: LatticeDispatchItem[] }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<LatticeDispatchResult[]>>
}
