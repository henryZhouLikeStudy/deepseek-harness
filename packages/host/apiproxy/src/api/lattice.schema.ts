/** Zod schemas for the lattice group-dispatch domain. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'

/** lattice.groupDispatch request item. */
export const latticeDispatchItemSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'lattice.groupDispatch'>['items'][number]>>

/** lattice.groupDispatch request payload. */
export const latticeGroupDispatchRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
  items: z.array(latticeDispatchItemSchema).min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'lattice.groupDispatch'>>>

/** lattice.groupDispatch response row. */
export const latticeDispatchResultSchema = z.object({
  childSessionId: sessionIdSchema,
  provider: z.string().min(1),
}) satisfies z.ZodType<Wire<ResponseValue<'lattice.groupDispatch'>[number]>>

/** lattice.listProviders request payload. */
export const latticeListProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'lattice.listProviders'>>>

/** lattice.listProviders response value: registered provider names in host order. */
export const latticeListProvidersValueSchema = z.array(z.string().min(1)) satisfies z.ZodType<Wire<ResponseValue<'lattice.listProviders'>>>

/** lattice.groupDispatch response value. */
export const latticeGroupDispatchValueSchema = z.array(latticeDispatchResultSchema) satisfies z.ZodType<Wire<ResponseValue<'lattice.groupDispatch'>>>
