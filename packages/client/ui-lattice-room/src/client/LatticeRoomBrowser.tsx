/** Lattice room browser component. */
import { useEffect, useRef, useState } from 'react'
import type { LatticeRoomProps } from './contract/slots.ts'
import type { Room, RoomMember, SubagentProvider } from './stores.ts'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'

export function LatticeRoomBrowser(props: LatticeRoomProps): JSX.Element {
  const { useStore, actions, listProviders, openSubagent, sendTaskToMember, fetchChildResult, useSessions, t } = props
  const listProvidersRef = useRef(listProviders)
  listProvidersRef.current = listProviders
  const state = useStore(s => s)
  const rooms = Object.values(state.rooms)
  const activeRoom = state.activeRoomId ? state.rooms[state.activeRoomId] : null

  const sessionsById = useSessions(s => s.byId)
  const currentSessionId = useSessions(s => s.current)

  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newRoomTitle, setNewRoomTitle] = useState('')
  const [taskInput, setTaskInput] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<SubagentProvider | null>(null)
  const [newMemberName, setNewMemberName] = useState('')
  const [providers, setProviders] = useState<SubagentProvider[] | undefined>(undefined)
  const [providersError, setProvidersError] = useState<string | undefined>(undefined)

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
      // Only stream results while the room's parent session is still current.
      if (child.parentSessionId !== currentSessionId) continue
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
  }, [activeRoom, state.pending, sessionsById, currentSessionId, actions, fetchChildResult, t])

  const handleCreateRoom = () => {
    if (!newRoomTitle.trim()) return
    const room: Room = {
      id: `room-${Date.now()}`,
      title: newRoomTitle,
      kind: 'group',
      members: [],
      messages: [],
    }
    actions.createRoom(room)
    setNewRoomTitle('')
    setShowCreateDialog(false)
  }

  const handleAddMember = () => {
    if (!activeRoom || !selectedProvider) return
    const member: RoomMember = { provider: selectedProvider, name: newMemberName.trim() || `${selectedProvider}-agent` }
    actions.addMember(activeRoom.id, member)
    setSelectedProvider(null)
    setNewMemberName('')
  }

  const handleSendTask = async () => {
    if (!activeRoom || !taskInput.trim()) return
    const taskMessage = {
      id: `msg-${Date.now()}`,
      sender: 'user',
      kind: 'task' as const,
      text: taskInput,
      createdAt: Date.now(),
    }
    actions.sendMessage(activeRoom.id, taskMessage)

    // Dispatch to every member concurrently; each member posts its own status
    // message once its task is accepted, so a slow provider does not block the
    // rest of the room.
    await Promise.all(activeRoom.members.map(async (member) => {
      try {
        const { text, children } = await sendTaskToMember(activeRoom.id, member, taskInput)
        if (children.length > 0) actions.addPendingChildren(activeRoom.id, children)
        actions.sendMessage(activeRoom.id, {
          id: `msg-status-${Date.now()}-${member.name}`,
          sender: 'system',
          kind: 'status',
          text,
          createdAt: Date.now(),
        })
      } catch (error) {
        actions.sendMessage(activeRoom.id, {
          id: `msg-status-err-${Date.now()}-${member.name}`,
          sender: 'system',
          kind: 'status',
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          createdAt: Date.now(),
        })
      }
    }))
    setTaskInput('')
  }

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
            onChange={(e) => setNewRoomTitle(e.target.value)}
            placeholder={t('lattice-room.roomTitle')}
            style={{ marginBottom: '0.5rem' }}
          />
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
                onClick={() => openSubagent(provider, `${provider}-agent`)}
                style={{ padding: '0.5rem', cursor: 'pointer', borderRadius: '4px', marginBottom: '0.25rem' }}
                className={clsx('contact-item')}
              >
                {provider}
              </div>
            ))
          )}

          <h3 style={{ marginTop: '1rem' }}>Rooms</h3>
          {rooms.length === 0 && <p style={{ fontSize: '0.875rem', color: '#666' }}>{t('lattice-room.noRooms')}</p>}
          {rooms.map(room => (
            <div
              key={room.id}
              onClick={() => actions.openRoom(room.id)}
              style={{
                padding: '0.5rem',
                cursor: 'pointer',
                borderRadius: '4px',
                marginBottom: '0.25rem',
                backgroundColor: activeRoom?.id === room.id ? '#e0e0e0' : 'transparent',
              }}
            >
              {room.title}
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
                  {activeRoom.members.map((member, idx) => (
                    <span
                      key={idx}
                      style={{
                        padding: '0.25rem 0.5rem',
                        backgroundColor: '#f0f0f0',
                        borderRadius: '4px',
                        fontSize: '0.875rem',
                      }}
                    >
                      {member.name} ({member.provider})
                      <button
                        onClick={() => actions.removeMember(activeRoom.id, idx)}
                        style={{ marginLeft: '0.5rem', cursor: 'pointer', border: 'none', background: 'transparent' }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <Input
                    value={newMemberName}
                    onChange={(e) => setNewMemberName(e.target.value)}
                    placeholder={t('lattice-room.memberName')}
                    style={{ padding: '0.25rem', width: '10rem' }}
                  />
                  <select
                    value={selectedProvider ?? ''}
                    onChange={(e) => setSelectedProvider(e.target.value as SubagentProvider)}
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
                {activeRoom.messages.map(msg => (
                  <div key={msg.id} style={{ marginBottom: '0.75rem', padding: '0.5rem', backgroundColor: '#f9f9f9', borderRadius: '4px' }}>
                    <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: '0.25rem' }}>
                      <strong>{msg.sender}</strong> · {msg.kind} · {new Date(msg.createdAt).toLocaleTimeString()}
                    </div>
                    <div>{msg.text}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <Input
                  value={taskInput}
                  onChange={(e) => setTaskInput(e.target.value)}
                  placeholder={t('lattice-room.taskInput')}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendTask()}
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
