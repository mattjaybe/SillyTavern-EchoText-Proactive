# SillyTavern-EchoText-Proactive

Server plugin for EchoText that enables proactive message generation even when the browser tab is backgrounded or minimized.

## How it works

When a SillyTavern browser tab is not in focus, JavaScript timers are throttled by the browser — making EchoText's client-side proactive messaging scheduler unreliable. This server plugin fixes that by running an un-throttled Node.js scheduler server-side.

```
Browser (EchoText)          SillyTavern Server Plugin
─────────────────           ──────────────────────────
tab focused/active          setInterval (never throttled)
  ↓ register state ──────► evaluates triggers every 60s
  ↓ poll /pending  ◄────── generates via ollama/openai directly
  ↓ merge messages         OR queues deferred trigger for client
```

- **ollama / openai sources**: server generates messages directly
- **default / profile sources**: server queues a deferred trigger; client executes generation immediately on next poll/tab-focus

## Installation

1. Copy or symlink this folder into SillyTavern's `plugins/` directory:
   ```
   SillyTavern/plugins/echotext-proactive/
   ```

2. In SillyTavern's `config.yaml`, ensure:
   ```yaml
   enableServerPlugins: true
   ```

3. Restart SillyTavern. You should see in the server console:
   ```
   [EchoText-Proactive] Plugin loaded. Version: 1.0.0
   [EchoText-Proactive] Scheduler started (tick every 60s).
   ```

4. Open EchoText in the browser. When Proactive Messaging is enabled and a character is loaded in Tethered mode, the browser console will show:
   ```
   [EchoText-Proactive] Server plugin detected v1.0.0. Background generation enabled.
   ```

## API Endpoints

All endpoints are under `/api/plugins/echotext-proactive/`:

| Method | Path | Description |
|---|---|---|
| `GET` | `/status` | Health check |
| `POST` | `/register` | Client pushes character state |
| `GET` | `/pending?key=...` | Poll for queued messages |
| `POST` | `/ack` | Acknowledge received messages |
| `POST` | `/heartbeat` | Keep registration alive (lightweight) |

## Configuration

The plugin uses whatever LLM settings EchoText is configured with — no separate configuration required. Generation source and API endpoints are pushed from the browser extension on registration.

## Requirements

- SillyTavern with `enableServerPlugins: true`
- Node.js 18+ (for native `fetch`)
- For background generation: `ollama` or `openai`-compatible source in EchoText settings
