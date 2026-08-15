/**
 * Lattice room store: rooms, contacts, and messaging state.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Known subagent provider names. */
export type SubagentProvider = 'claude-code' | 'codex' | 'acp' | 'dsh-sdk' | 'in-process' | 'spawn' | 'fork'

/** Room kind: group chat or 1:1. */
export type RoomKind = 'group' | '1:1'

/** Room member. */
export interface RoomMember {
  provider: SubagentProvider
  name: string
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
}

/** Room data model. */
export interface Room {
  id: string
  title: string
  kind: RoomKind
  projectId?: string
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
}

type LatticeRoomActions = {
  createRoom: (draft: LatticeRoomState, room: Room) => void
  openRoom: (draft: LatticeRoomState, roomId: string) => void
  addMember: (draft: LatticeRoomState, roomId: string, member: RoomMember) => void
  removeMember: (draft: LatticeRoomState, roomId: string, memberIndex: number) => void
  sendMessage: (draft: LatticeRoomState, roomId: string, message: RoomMessage) => void
  setContacts: (draft: LatticeRoomState, contacts: Contact[]) => void
  deleteRoom: (draft: LatticeRoomState, roomId: string) => void
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
        if (d.activeRoomId === roomId) {
          d.activeRoomId = null
        }
      },
    },
  })
}
