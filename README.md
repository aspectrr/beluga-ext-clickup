# beluga-ext-clickup

ClickUp connector + tools extension for [Beluga](https://github.com/aspectrr/beluga).

## What It Does

- Polls ClickUp for new tasks, mentions, and thread replies
- Creates agent sessions when the agent is @mentioned or assigned
- Registers 6 tools for interacting with ClickUp:

| Tool | Description |
|------|-------------|
| `clickup_get_task` | Get full task details |
| `clickup_update_task` | Update task name, status, priority, etc. |
| `clickup_post_comment` | Post a comment on a task |
| `clickup_reply_comment` | Reply to a specific comment in a thread |
| `clickup_search_tasks` | Search tasks with filters |
| `clickup_get_attachments` | Get attachments for a task |

## Installation

```bash
beluga extend install github.com/aspectrr/beluga-ext-clickup
```

Or from a local clone:

```bash
beluga extend install ./beluga-ext-clickup
```

Then add to `beluga.yaml`:

```yaml
extensions:
  clickup:
    enabled: true
    api_token: "${CLICKUP_API_TOKEN}"
    team_id: "your-team-id"
    space_id: "your-space-id"
    agent_username: "Beluga Agent"
    poll_interval: "30s"
```

## How It Works

This is a **local extension** — it's compiled into the Beluga binary.

1. `beluga extend install` copies the Go source files into `internal/extensions/clickup/`
2. Registers the extension in `cmd/beluga/main.go`
3. Rebuilds the Beluga binary
4. The poller starts on `Start()` and creates sessions via `CreateSession` when it detects events

## Config Options

| Key | Required | Description |
|-----|----------|-------------|
| `api_token` | Yes | ClickUp personal token (pk_...) or OAuth access token |
| `team_id` | Yes | ClickUp team ID |
| `space_id` | No | Filter tasks to a specific space |
| `list_id` | No | Filter tasks to a specific list |
| `agent_username` | No | Username to detect @mentions (default: "Beluga Agent") |
| `poll_interval` | No | How often to poll (default: 30s) |
| `proxy` | No | HTTP proxy URL |

## Development

This extension imports Beluga's internal packages. It compiles when placed inside the Beluga source tree at `internal/extensions/clickup/`. To develop:

```bash
# Clone Beluga and this extension side by side
git clone https://github.com/aspectrr/beluga
git clone https://github.com/aspectrr/beluga-ext-clickup

# Install into Beluga's source tree
cd beluga
beluga extend install ../beluga-ext-clickup

# Build and test
go build ./...
go test ./internal/extensions/clickup/...
```

## Files

- `extension.go` — Implements `extension.Extension` (Init/Start/Stop)
- `client.go` — ClickUp REST API client with retry logic
- `poller.go` — Background poller for task events + mention detection
- `tools.go` — 6 ClickUp tools with dry-run support
- `types.go` — ClickUp API types (Task, Comment, User, etc.)
