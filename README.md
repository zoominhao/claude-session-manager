# Claude Session Manager

A VSCode sidebar extension for managing Claude Code conversation sessions across multiple machines.

![VSCode](https://img.shields.io/badge/VSCode-%3E%3D1.85.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Session Browser** - View all Claude sessions with creation time, message count, context size, and version info
- **Active Detection** - Real-time monitoring with green highlight for sessions currently in use
- **Session Actions** - Rename, resume, delete, open raw `.jsonl` file, copy session ID
- **Project Filtering** - Filter sessions by project directory
- **Multi-Machine Sync** - Sync sessions across macOS/Windows/Linux via WebDAV
- **Machine Grouping** - Sessions auto-grouped by machine with platform icons
- **Cross-Machine Resume** - Resume sessions from other machines locally

## Screenshot

```
Sessions
├── MacBook Pro                    14 sessions
│   ├── Build a VSCode extension   521 KB · 187 msgs · just now
│   ├── Debug API integration      120 KB · 45 msgs · 2h ago
│   └── ...
├── Work PC                        40 sessions
│   ├── Refactor auth module       89 KB · 32 msgs · 1d ago
│   └── ...
```

## Installation

### From VSIX

```bash
cd claude-session-manager
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
code --install-extension claude-session-manager-1.0.0.vsix
```

### From Source

```bash
git clone https://github.com/zoominhao/claude-session-manager.git
cd claude-session-manager
npm install
npm run compile
```

Then press `F5` in VSCode to launch the extension in debug mode.

## Configuration

### Basic Setup

Works out of the box with default `~/.claude` directory. For multi-machine setups, configure `claudeDirs`:

```json
"claudeSessionManager.claudeDirs": [
  {
    "path": "~/.claude",
    "platform": "darwin",
    "hostname": "My-MacBook",
    "name": "MacBook Pro",
    "label": "Mac"
  },
  {
    "path": "C:\\Users\\me\\.claude",
    "platform": "win32",
    "hostname": "WORK-PC",
    "name": "Work PC",
    "label": "Windows"
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | Path to `.claude` directory |
| `platform` | No | `darwin`, `win32`, `linux`, or `all` |
| `hostname` | No | Machine hostname (run `hostname` to check). Required when multiple machines share the same platform |
| `name` | No | Machine display name |
| `label` | No | Source label |

### WebDAV Sync

Sync sessions across machines via WebDAV (tested with Jianguoyun/坚果云):

1. Run command **Configure WebDAV Sync** from the sidebar context menu
2. Enter WebDAV URL, username, and app-specific password
3. Sessions sync automatically on startup and at configurable intervals

```json
"claudeSessionManager.sync.enabled": true,
"claudeSessionManager.sync.webdavUrl": "https://dav.jianguoyun.com/dav/ClaudeSessions",
"claudeSessionManager.sync.webdavUsername": "your@email.com",
"claudeSessionManager.sync.autoSyncInterval": 3600,
"claudeSessionManager.sync.syncOnStartup": true
```

Password is stored securely in VSCode's SecretStorage.

#### Cloud Storage Structure

Sessions are isolated by hostname to prevent conflicts:

```
/ClaudeSessions/
  hosts/
    My-MacBook/
      machine.json
      history.jsonl
      projects/
        -Users-me-Projects-myapp/
          session1.jsonl
    WORK-PC/
      machine.json
      history.jsonl
      projects/
        c--Work-myapp/
          session2.jsonl
  session-names.json
```

### Other Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `autoRefreshInterval` | `10` | Auto-refresh interval in seconds (0 to disable) |

## Commands

| Command | Description |
|---------|-------------|
| Refresh Sessions | Reload all sessions |
| Rename Session | Set a custom display name |
| Resume Session | Open in terminal with `claude --resume` |
| Open Session File | View the raw `.jsonl` file |
| Copy Session ID | Copy to clipboard |
| Delete Session | Delete locally and from WebDAV |
| Filter by Project | Show sessions from a specific project |
| Sync Sessions Now | Trigger manual WebDAV sync |
| Configure WebDAV Sync | Setup sync credentials |

## How It Works

### Session Data

Claude Code stores sessions at `~/.claude/projects/{encoded-path}/{session-id}.jsonl`. Each file contains JSONL records of user messages, assistant responses, tool calls, and metadata.

### Active Detection

A session is detected as active when its last queue operation is `dequeue` and the file was modified within the last 30 seconds.

### Machine Identification

Machines are identified through (in priority order):

1. `claudeDirs` config with `name` field
2. Machine descriptors auto-synced via WebDAV
3. Project directory path pattern inference (`-Users-` = macOS, `C-Users-` = Windows)

### Cross-Machine Resume

When resuming a session from another machine, the extension copies the session file to the local `.claude/projects/` directory so Claude CLI can find it.

## Technical Details

- Zero production dependencies - WebDAV uses native `fetch` with Basic Auth
- Adaptive rate limiting with exponential backoff for WebDAV services
- Incremental sync via manifest tracking
- File system watcher for real-time session status updates

## License

MIT
