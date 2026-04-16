# EchoText Proactive — Server Plugin

> **Your characters keep talking even when the tab isn't open.**

EchoText already supports proactive messaging — characters that reach out on their own with check-ins, morning greetings, late-night messages, and more. But browsers quietly throttle background tabs, which means those messages stop firing reliably the moment you minimize or switch away.

This server plugin solves that. It runs quietly alongside SillyTavern and keeps the proactive scheduler ticking at full speed no matter what your browser is doing. Install it once and forget about it — everything else works automatically through EchoText's existing Proactive Messaging settings.

---

## What changes after installing

- Characters send proactive messages reliably even when SillyTavern is minimized or the tab is in the background
- Morning messages actually arrive in the morning. Late-night check-ins actually arrive at night
- No new settings to learn — EchoText detects the plugin automatically and switches to server-backed scheduling

---

## Installation

### Step 1 — Clone the plugin into SillyTavern

Open a terminal, navigate to your SillyTavern folder, and run:

```bash
git clone https://github.com/mattjaybe/SillyTavern-EchoText-Proactive plugins/echotext-proactive
```

> **Don't have Git?** You can also download this repository as a ZIP, extract it, and place the folder at `SillyTavern/plugins/echotext-proactive/`.

### Step 2 — Enable server plugins in SillyTavern

Open `SillyTavern/config.yaml` in any text editor and make sure this line is present and set to `true`:

```yaml
enableServerPlugins: true
```

### Step 3 — Restart SillyTavern

Stop and restart SillyTavern. If the plugin loaded correctly, you'll see this in the server console:

```
[EchoText-Proactive] Plugin loaded. Version: 1.0.0
[EchoText-Proactive] Scheduler started (tick every 60s).
```

### Step 4 — Confirm it's working

Open EchoText in the browser with a character loaded and Proactive Messaging enabled. Check the browser console (F12) — you should see:

```
[EchoText-Proactive] Server plugin detected v1.0.0. Background generation enabled.
```

That's it — no further configuration needed.

---

## Notes

- **No extra setup required.** The plugin picks up whatever generation source you've already configured in EchoText (Ollama, OpenAI-compatible, Connection Profile, etc.).
- **Ollama / OpenAI sources** generate messages directly on the server side, so they arrive even if you never return to the tab.
- **Default / Connection Profile sources** queue a trigger that fires the moment you return to the tab or EchoText polls — still much more reliable than the browser-only scheduler.
- This plugin stores everything in memory only. Nothing is written to disk, and all state clears when SillyTavern restarts.
