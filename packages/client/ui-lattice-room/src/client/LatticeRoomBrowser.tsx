/** Lattice room browser component. */
import { useEffect, useRef, useState } from 'react'
import type { LatticeRoomProps } from './contract/slots.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { Room, RoomKind, RoomMember, SubagentProvider } from './stores.ts'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'

export function LatticeRoomBrowser(props: LatticeRoomProps): JSX.Element {
  const {
    useStore, actions, listProviders, sendTaskToMember, fetchChildResult, openChildSession, relay, useSessions, useWorkspaces, t,
  } = props
  const listProvidersRef = useRef(listProviders)
  listProvidersRef.current = listProviders
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const state = useStore(s => s)
  const rooms = Object.values(state.rooms)
  const activeRoom = state.activeRoomId ? state.rooms[state.activeRoomId] : null

  const sessionsById = useSessions(s => s.byId)
  const workspaces = useWorkspaces(s => s.items)

  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newRoomTitle, setNewRoomTitle] = useState('')
  const [taskInput, setTaskInput] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<SubagentProvider | null>(null)
  const [newMemberName, setNewMemberName] = useState('')
  const [newRoomKind, setNewRoomKind] = useState<RoomKind>('group')
  const [newRoomProject, setNewRoomProject] = useState<{ id: string; title: string } | null>(null)
  const [editingMember, setEditingMember] = useState<{ index: number; name: string } | null>(null)
  const [forwardingMessage, setForwardingMessage] = useState<{ id: string; text: string; fromChild: SessionId } | null>(null)
  const [providers, setProviders] = useState<SubagentProvider[] | undefined>(undefined)
  const [providersError, setProvidersError] = useState<string | undefined>(undefined)
  const idSeq = useRef(0)
  const nextMsgSuffix = () => `${Date.now()}-${idSeq.current++}`

  useEffect(() => {
    setForwardingMessage(null)
  }, [activeRoom?.id])

  useEffect(() => {
    let cancelled = false
    listProvidersRef.current()
      .then((list) => {
        if (cancelled) return
        setProviders(list)
        setProvidersError(undefined)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setProviders([])
        setProvidersError(error instanceof Error ? error.message : 'Unknown error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!activeRoom) return
    const pending = state.pending[activeRoom.id] ?? []
    for (const child of pending) {
      const summary = sessionsById[child.childSessionId]
      if (!summary || summary.running) continue
      // Remove synchronously so a later effect pass does not reprocess this child.
      actions.removePendingChild(activeRoom.id, child.childSessionId)
      void (async () => {
        try {
          const text = await fetchChildResult(child.parentSessionId, child.childSessionId)
          if (text !== undefined) {
            actions.sendMessage(activeRoom.id, {
              id: `msg-result-${child.childSessionId}`,
              sender: child.memberName,
              kind: 'result',
              text,
              createdAt: Date.now(),
              childAddress: { parentSessionId: child.parentSessionId, childSessionId: child.childSessionId, mode: 'one-shot' },
            })
          } else {
            actions.sendMessage(activeRoom.id, {
              id: `msg-no-result-${child.childSessionId}`,
              sender: 'system',
              kind: 'status',
              text: t('lattice-room.noResult', { member: child.memberName }),
              createdAt: Date.now(),
            })
          }
        } catch (error) {
          actions.sendMessage(activeRoom.id, {
            id: `msg-err-${child.childSessionId}`,
            sender: 'system',
            kind: 'status',
            text: t('lattice-room.resultError', {
              member: child.memberName,
              error: error instanceof Error ? error.message : 'Unknown error',
            }),
            createdAt: Date.now(),
          })
        }
      })()
    }
  }, [activeRoom, state.pending, sessionsById, actions, fetchChildResult, t])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [activeRoom?.id, activeRoom?.messages.length])

  const handleCreateRoom = () => {
    if (!newRoomTitle.trim()) return
    const room: Room = {
      id: `room-${Date.now()}`,
      title: newRoomTitle,
      kind: newRoomKind,
      ...(newRoomProject !== null ? { projectId: newRoomProject.id, projectTitle: newRoomProject.title } : {}),
      members: [],
      messages: [],
    }
    actions.createRoom(room)
    setNewRoomTitle('')
    setNewRoomKind('group')
    setNewRoomProject(null)
    setShowCreateDialog(false)
  }

  const handleAddMember = () => {
    if (!activeRoom || !selectedProvider) return
    if (activeRoom.kind === '1:1' && activeRoom.members.length >= 1) return
    const member: RoomMember = { provider: selectedProvider, name: newMemberName.trim() || `${selectedProvider}-agent` }
    actions.addMember(activeRoom.id, member)
    setSelectedProvider(null)
    setNewMemberName('')
  }

  const handleOpenContact = (provider: SubagentProvider) => {
    const existing = rooms.find(room => room.kind === '1:1' && room.members.length === 1 && room.members[0]?.provider === provider)
    if (existing) {
      actions.openRoom(existing.id)
      return
    }
    const room: Room = {
      id: `room-${Date.now()}`,
      title: provider,
      kind: '1:1',
      members: [{ provider, name: `${provider}-agent` }],
      messages: [],
    }
    actions.createRoom(room)
  }

  const handleAddContactToRoom = (provider: SubagentProvider) => {
    if (!activeRoom || activeRoom.kind !== 'group') return
    if (activeRoom.members.some(member => member.provider === provider)) return
    const member: RoomMember = { provider, name: `${provider}-agent` }
    actions.addMember(activeRoom.id, member)
  }

  const handleSendTask = async () => {
    if (!activeRoom || !taskInput.trim()) return
    if (activeRoom.members.length === 0) {
      actions.sendMessage(activeRoom.id, {
        id: `msg-${nextMsgSuffix()}-empty`,
        sender: 'system',
        kind: 'status',
        text: t('lattice-room.noMembers'),
        createdAt: Date.now(),
      })
      setTaskInput('')
      return
    }
    const taskMessage = {
      id: `msg-${nextMsgSuffix()}`,
      sender: 'user',
      kind: 'task' as const,
      text: taskInput,
      createdAt: Date.now(),
    }
    actions.sendMessage(activeRoom.id, taskMessage)

    // Dispatch to every member concurrently; each member posts its own status
    // message once its task is accepted, so a slow provider does not block the
    // rest of the room. Snapshot the roster first and relocate each member by
    // identity after the async dispatch so a concurrent reorder does not write
    // the child session id to the wrong array index.
    const membersSnapshot = [...activeRoom.members]
    await Promise.all(membersSnapshot.map(async (member) => {
      try {
        const { text, children, childSessionId } = await sendTaskToMember(activeRoom.id, member, taskInput)
        const currentIndex = activeRoom.members.findIndex(m => m.provider === member.provider && m.name === member.name)
        if (childSessionId !== undefined && currentIndex !== -1) {
          actions.setMemberChildSession(activeRoom.id, currentIndex, childSessionId)
        }
        if (children.length > 0) actions.addPendingChildren(activeRoom.id, children)
        actions.sendMessage(activeRoom.id, {
          id: `msg-status-${nextMsgSuffix()}-${member.name}`,
          sender: 'system',
          kind: 'status',
          text,
          createdAt: Date.now(),
        })
      } catch (error) {
        actions.sendMessage(activeRoom.id, {
          id: `msg-status-err-${nextMsgSuffix()}-${member.name}`,
          sender: 'system',
          kind: 'status',
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          createdAt: Date.now(),
        })
      }
    }))
    setTaskInput('')
  }

  const ungroupedRooms = rooms.filter(room => room.projectId === undefined)
  const projectGroups = rooms.reduce<Array<{ projectId: string; title: string; rooms: Room[] }>>((groups, room) => {
    const pid = room.projectId
    if (pid === undefined) return groups
    let group = groups.find(g => g.projectId === pid)
    if (!group) {
      group = { projectId: pid, title: room.projectTitle ?? pid, rooms: [] }
      groups.push(group)
    }
    group.rooms.push(room)
    return groups
  }, [])

  const roomItem = (room: Room) => (
    <div
      key={room.id}
      onClick={() => actions.openRoom(room.id)}
      style={{
        padding: '0.5rem',
        cursor: 'pointer',
        borderRadius: '4px',
        marginBottom: '0.25rem',
        backgroundColor: activeRoom?.id === room.id ? '#e0e0e0' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.25rem',
      }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {room.title}
        <span style={{ fontSize: '0.7rem', color: '#999', marginLeft: '0.25rem' }}>
          {room.kind === '1:1' ? t('lattice-room.oneOnOne') : t('lattice-room.group')}
        </span>
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); actions.deleteRoom(room.id) }}
        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#999' }}
        aria-label={t('lattice-room.delete')}
      >
        ×
      </button>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>{t('lattice-room.title')}</h2>
        <Button onClick={() => setShowCreateDialog(true)}>{t('lattice-room.new')}</Button>
      </div>

      {showCreateDialog && (
        <div style={{ padding: '1rem', border: '1px solid #ccc', borderRadius: '4px', marginBottom: '1rem' }}>
          <Input
            value={newRoomTitle}
            onChange={e => setNewRoomTitle(e.target.value)}
            placeholder={t('lattice-room.roomTitle')}
            style={{ marginBottom: '0.5rem' }}
          />
          <select
            value={newRoomKind}
            onChange={e => setNewRoomKind(e.target.value as RoomKind)}
            style={{ padding: '0.25rem', marginBottom: '0.5rem' }}
          >
            <option value="group">{t('lattice-room.group')}</option>
            <option value="1:1">{t('lattice-room.oneOnOne')}</option>
          </select>
          <select
            value={newRoomProject?.id ?? ''}
            onChange={(e) => {
              const id = e.target.value
              const ws = workspaces.find(w => w.workspaceId === id)
              setNewRoomProject(id === '' ? null : { id, title: ws?.title ?? id })
            }}
            style={{ padding: '0.25rem', marginBottom: '0.5rem' }}
          >
            <option value="">{t('lattice-room.noProject')}</option>
            {workspaces.map(ws => (
              <option key={ws.workspaceId} value={ws.workspaceId}>{ws.title}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Button onClick={handleCreateRoom}>{t('lattice-room.create')}</Button>
            <Button onClick={() => setShowCreateDialog(false)}>{t('lattice-room.cancel')}</Button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, gap: '1rem', overflow: 'hidden' }}>
        <div style={{ width: '200px', borderRight: '1px solid #ccc', paddingRight: '1rem', overflowY: 'auto' }}>
          <h3>{t('lattice-room.contacts')}</h3>
          {providers === undefined ? (
            <p style={{ fontSize: '0.875rem', color: '#666' }}>{t('lattice-room.loadingProviders')}</p>
          ) : providers.length === 0 ? (
            <p style={{ fontSize: '0.875rem', color: '#666' }}>{providersError ?? t('lattice-room.noProviders')}</p>
          ) : (
            providers.map(provider => (
              <div
                key={provider}
                style={{ padding: '0.5rem', borderRadius: '4px', marginBottom: '0.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.25rem' }}
                className={clsx('contact-item')}
              >
                <span
                  onClick={() => handleOpenContact(provider)}
                  style={{ cursor: 'pointer', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {provider}
                </span>
                {activeRoom?.kind === 'group' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleAddContactToRoom(provider) }}
                    disabled={activeRoom.members.some(member => member.provider === provider)}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#666', fontSize: '1rem', lineHeight: '1' }}
                    title={t('lattice-room.addMember')}
                    aria-label={t('lattice-room.addMember')}
                  >
                    +
                  </button>
                )}
              </div>
            ))
          )}

          <h3 style={{ marginTop: '1rem' }}>Rooms</h3>
          {rooms.length === 0 && <p style={{ fontSize: '0.875rem', color: '#666' }}>{t('lattice-room.noRooms')}</p>}
          {ungroupedRooms.length > 0 && (
            <>
              <div style={{ fontSize: '0.75rem', color: '#999', margin: '0.5rem 0 0.25rem' }}>{t('lattice-room.noProject')}</div>
              {ungroupedRooms.map(roomItem)}
            </>
          )}
          {projectGroups.map(group => (
            <div key={group.projectId}>
              <div style={{ fontSize: '0.75rem', color: '#999', margin: '0.5rem 0 0.25rem' }}>{group.title}</div>
              {group.rooms.map(roomItem)}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {activeRoom ? (
            <>
              <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid #ccc' }}>
                <h3 style={{ margin: '0 0 0.5rem 0' }}>{activeRoom.title}</h3>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>{t('lattice-room.members')}:</span>
                  {activeRoom.members.map((member, idx) => {
                    const editing = editingMember !== null && editingMember.index === idx ? editingMember : null
                    return (
                      <span
                        key={idx}
                        style={{
                          padding: '0.25rem 0.5rem',
                          backgroundColor: '#f0f0f0',
                          borderRadius: '4px',
                          fontSize: '0.875rem',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                        }}
                      >
                        {editing !== null ? (
                          <>
                            <Input
                              value={editing.name}
                              onChange={e => setEditingMember({ index: idx, name: e.target.value })}
                              style={{ padding: '0.125rem 0.25rem', width: '6rem' }}
                            />
                            <button
                              onClick={() => {
                                actions.renameMember(activeRoom.id, idx, editing.name.trim() || member.name)
                                setEditingMember(null)
                              }}
                              style={{ cursor: 'pointer', border: 'none', background: 'transparent' }}
                              title={t('lattice-room.save')}
                            >
                              ✓
                            </button>
                            <button
                              onClick={() => setEditingMember(null)}
                              style={{ cursor: 'pointer', border: 'none', background: 'transparent' }}
                              title={t('lattice-room.cancel')}
                            >
                              ×
                            </button>
                          </>
                        ) : (
                          <>
                            {member.name} ({member.provider})
                            <button
                              onClick={() => setEditingMember({ index: idx, name: member.name })}
                              style={{ marginLeft: '0.25rem', cursor: 'pointer', border: 'none', background: 'transparent' }}
                              title={t('lattice-room.edit')}
                            >
                              ✎
                            </button>
                            {member.childSessionId !== undefined && (
                              <button
                                onClick={() => actions.setMemberChildSession(activeRoom.id, idx, undefined)}
                                style={{ cursor: 'pointer', border: 'none', background: 'transparent' }}
                                title={t('lattice-room.resetSession')}
                              >
                                ↺
                              </button>
                            )}
                            <button
                              onClick={() => actions.removeMember(activeRoom.id, idx)}
                              style={{ cursor: 'pointer', border: 'none', background: 'transparent' }}
                              title={t('lattice-room.removeMember')}
                            >
                              ×
                            </button>
                          </>
                        )}
                      </span>
                    )
                  })}
                  <Input
                    value={newMemberName}
                    onChange={e => setNewMemberName(e.target.value)}
                    placeholder={t('lattice-room.memberName')}
                    style={{ padding: '0.25rem', width: '10rem' }}
                  />
                  <select
                    value={selectedProvider ?? ''}
                    onChange={e => setSelectedProvider(e.target.value as SubagentProvider)}
                    disabled={providers === undefined}
                    style={{ padding: '0.25rem' }}
                  >
                    <option value="">{t('lattice-room.selectProvider')}</option>
                    {(providers ?? []).map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <Button onClick={handleAddMember} disabled={!selectedProvider}>
                    {t('lattice-room.addMember')}
                  </Button>
                </div>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', marginBottom: '1rem', padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}>
                {activeRoom.messages.length === 0 && (
                  <p style={{ color: '#666', textAlign: 'center' }}>{t('lattice-room.noMessages')}</p>
                )}
                {activeRoom.messages.map((msg) => {
                  const childAddress = msg.childAddress
                  return (
                    <div
                      key={msg.id}
                      onClick={childAddress !== undefined ? () => openChildSession(childAddress) : undefined}
                      style={{
                        marginBottom: '0.75rem',
                        padding: '0.5rem',
                        backgroundColor: '#f9f9f9',
                        borderRadius: '4px',
                        cursor: childAddress !== undefined ? 'pointer' : 'default',
                      }}
                      title={childAddress !== undefined ? t('lattice-room.openChild') : undefined}
                    >
                      <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: '0.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span><strong>{msg.sender}</strong> · {msg.kind} · {new Date(msg.createdAt).toLocaleTimeString()}</span>
                        {childAddress !== undefined && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setForwardingMessage({ id: msg.id, text: msg.text, fromChild: childAddress.childSessionId })
                            }}
                            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#666', fontSize: '0.75rem' }}
                            title={t('lattice-room.forward')}
                          >
                            {t('lattice-room.forward')}
                          </button>
                        )}
                      </div>
                      <div>{msg.text}</div>
                      {(() => {
                        const forward = forwardingMessage
                        if (forward === null || forward.id !== msg.id) return null
                        const targets = activeRoom.members.filter((member): member is RoomMember & { childSessionId: SessionId } =>
                          member.childSessionId !== undefined && member.childSessionId !== forward.fromChild)
                        return (
                          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                            {targets.length === 0 ? (
                              <span style={{ fontSize: '0.75rem', color: '#666' }}>{t('lattice-room.noForwardTargets')}</span>
                            ) : (
                              <>
                                {targets.map(member => (
                                  <button
                                    key={member.childSessionId}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void (async () => {
                                        const ok = await relay(forward.fromChild, member.childSessionId, forward.text)
                                        actions.sendMessage(activeRoom.id, {
                                          id: `msg-forward-${nextMsgSuffix()}`,
                                          sender: 'system',
                                          kind: 'status',
                                          text: ok ? `Forwarded to ${member.name}` : `Forward to ${member.name} failed`,
                                          createdAt: Date.now(),
                                        })
                                        setForwardingMessage(null)
                                      })()
                                    }}
                                    style={{
                                      border: '1px solid #ccc',
                                      borderRadius: '4px',
                                      padding: '0.25rem 0.5rem',
                                      cursor: 'pointer',
                                      background: '#fff',
                                      fontSize: '0.75rem',
                                    }}
                                  >
                                    {member.name}
                                  </button>
                                ))}
                                <button
                                  onClick={(e) => { e.stopPropagation(); setForwardingMessage(null) }}
                                  style={{
                                    border: '1px solid #ccc',
                                    borderRadius: '4px',
                                    padding: '0.25rem 0.5rem',
                                    cursor: 'pointer',
                                    background: '#fff',
                                    fontSize: '0.75rem',
                                  }}
                                >
                                  {t('lattice-room.cancel')}
                                </button>
                              </>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )
                })}
                <div ref={messagesEndRef} />
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <Input
                  value={taskInput}
                  onChange={e => setTaskInput(e.target.value)}
                  placeholder={t('lattice-room.taskInput')}
                  onKeyDown={e => e.key === 'Enter' && handleSendTask()}
                  style={{ flex: 1 }}
                />
                <Button onClick={handleSendTask}>{t('lattice-room.sendTask')}</Button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
              {t('lattice-room.createFirst')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
