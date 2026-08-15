# @deepseek-ai/dsh-client-ui-lattice-room

Group-chat rooms over the official subagent seam with AGENT contact management and task dispatch.

## Features

- **Room Management**: Create and manage group chat rooms with multiple subagent members
- **Contact Book**: Browse available subagent providers (claude-code, codex, acp, dsh-sdk, in-process, spawn, fork)
- **Task Dispatch**: Send tasks to room members and receive results
- **Message History**: Track tasks, results, and status messages in each room
- **Project Grouping**: Rooms can be associated with workspace projects

## Architecture

- **Store**: Persistent room state using the official defineStore API from client-runtime
- **Sessions Integration**: Uses ctx.sessions for subagent lifecycle (openSubagent, refreshSubagents)
- **Sidebar Integration**: Registers into the sidebar.latticeRooms slot declared by ui-sidebar

## Data Model

### Room
- `id`: Unique room identifier
- `title`: User-facing room name
- `kind`: 'group' or '1:1'
- `projectId`: Optional workspace project association
- `members`: Array of RoomMember (provider + name)
- `messages`: Array of RoomMessage (task/result/status/user)

### Message Kinds
- `task`: User-initiated task messages
- `result`: Subagent execution results
- `status`: System status updates
- `user`: Plain user messages

## Usage

The plugin automatically registers when ui-lattice-room is loaded. Access rooms via the sidebar navigation.

## Dependencies

- `@deepseek-ai/dsh-client-runtime`: Sessions and store APIs
- `@deepseek-ai/dsh-client-ui-primitives`: Button, Input components
- `@deepseek-ai/dsh-client-ui-sidebar`: Sidebar slot declarations
- `@deepseek-ai/dsh-client-locale`: Internationalization (zh + en)