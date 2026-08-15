/**
 * Lattice room store: rooms, contacts, messaging state, and pending child
 * results streamed back from dispatched subagents.
 */
import { defineStore, type EngineStoreHandle, type SessionId, type SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Subagent provider name. The roster is now fetched from the host, so the
 * type is a plain string rather than a closed union.
 */
export type SubagentProvider = string

/** Room kind: group chat or 1:1. */
export type RoomKind = 'group' | '1:1'

/** Room member. */
export interface RoomMember {
  provider: SubagentProvider
  name: string
}

/** Pending child result tracked for one room member. */
export interface PendingChild {
  memberName: string
  childSessionId: SessionId
  provider: string
  parentSessionId: SessionId
}

/** Message kinds. */
export type MessageKind = 'task' | 'result' | 'status' | 'user'

/** Room message. */
export interface RoomMessage {
  id: string
  sender: string
  kind: MessageKind
  text: string
  createdAt: number
  /** Optional child-session address so a result can be opened for traceability. */
  childAddress?: SubagentAddress
}

/** Room data model. */
export interface Room {
  id: string
  title: string
  kind: RoomKind
  projectId?: string
  /** Display title of the owning project, captured at create time for grouping. */
  projectTitle?: string
  members: RoomMember[]
  messages: RoomMessage[]
}

/** Contact entry. */
export interface Contact {
  provider: SubagentProvider
  available: boolean
}

/** Lattice room state. */
type LatticeRoomState = {
  rooms: Record<string, Room>
  contacts: Contact[]
  activeRoomId: string | null
  pending: Record<string, PendingChild[]>
}

type LatticeRoomActions = {
  createRoom: (draft: LatticeRoomState, room: Room) => void
  openRoom: (draft: LatticeRoomState, roomId: string) => void
  addMember: (draft: LatticeRoomState, roomId: string, member: RoomMember) => void
  removeMember: (draft: LatticeRoomState, roomId: string, memberIndex: number) => void
  renameMember: (draft: LatticeRoomState, roomId: string, memberIndex: number, name: string) => void
  sendMessage: (draft: LatticeRoomState, roomId: string, message: RoomMessage) => void
  setContacts: (draft: LatticeRoomState, contacts: Contact[]) => void
  deleteRoom: (draft: LatticeRoomState, roomId: string) => void
  addPendingChildren: (draft: LatticeRoomState, roomId: string, children: PendingChild[]) => void
  removePendingChild: (draft: LatticeRoomState, roomId: string, childSessionId: SessionId) => void
}

/**
 * Create the lattice room store handle.
 * @returns the store handle.
 */
export function createLatticeRoomStore(): EngineStoreHandle<LatticeRoomState, LatticeRoomActions> {
  return defineStore({
    init: (): LatticeRoomState => ({
      rooms: {},
      contacts: [],
      activeRoomId: null,
      pending: {},
    }),
    persist: 'dsh.lattice-room.v1',
    actions: {
      createRoom: (d, room: Room) => {
        d.rooms[room.id] = room
        d.activeRoomId = room.id
      },
      openRoom: (d, roomId: string) => {
        if (d.rooms[roomId]) {
          d.activeRoomId = roomId
        }
      },
      addMember: (d, roomId: string, member: RoomMember) => {
        const room = d.rooms[roomId]
        if (room) {
          room.members.push(member)
        }
      },
      removeMember: (d, roomId: string, memberIndex: number) => {
        const room = d.rooms[roomId]
        if (room && room.members[memberIndex]) {
          room.members.splice(memberIndex, 1)
        }
      },
      renameMember: (d, roomId: string, memberIndex: number, name: string) => {
        const room = d.rooms[roomId]
        if (room && room.members[memberIndex]) {
          room.members[memberIndex].name = name
        }
      },
      sendMessage: (d, roomId: string, message: RoomMessage) => {
        const room = d.rooms[roomId]
        if (room) {
          room.messages.push(message)
        }
      },
      setContacts: (d, contacts: Contact[]) => {
        d.contacts = contacts
      },
      deleteRoom: (d, roomId: string) => {
        delete d.rooms[roomId]
        delete d.pending[roomId]
        if (d.activeRoomId === roomId) {
          d.activeRoomId = null
        }
      },
      addPendingChildren: (d, roomId: string, children: PendingChild[]) => {
        const list = d.pending[roomId] ?? []
        list.push(...children)
        d.pending[roomId] = list
      },
      removePendingChild: (d, roomId: string, childSessionId: SessionId) => {
        const list = d.pending[roomId]
        if (list) {
          d.pending[roomId] = list.filter(c => c.childSessionId !== childSessionId)
        }
      },
    },
  })
}
