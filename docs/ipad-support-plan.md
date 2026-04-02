# iPad Support Plan

- Status: Draft / Brainstorming
- Date: 2026-03-18

## Motivation

The open-agent daemon currently runs on macOS. When working from an iPad via SSH, there's no local daemon to receive commands. Despite iPadOS constraints, a useful subset of the workflow can be made to work.

For transport/connectivity details (Unix socket, TCP fallback, Tailscale direct), see [connectivity-plan.md](connectivity-plan.md).

## iPadOS App (Swift)

**Goal**: A native iPadOS app (`open-agent-ios`) that receives commands from remote hosts and executes local actions.

### Distribution

Personal use only — side-loaded directly from Xcode to the iPad. No App Store or TestFlight distribution planned. This removes review constraints and allows use of private APIs or entitlements if needed.

### Repository

Separate repo: `open-agent-ios` (Swift/SwiftUI)

### Core Capabilities

| Action | Implementation |
|--------|---------------|
| Open URL | `UIApplication.shared.open(url)` — opens in Safari |
| Clipboard write | `UIPasteboard.general.string = content` |
| Clipboard read | `UIPasteboard.general.string` |
| Open file | Open via Files app provider (see below) |
| VS Code | Open `vscode.dev` tunnel URL in Safari or Blink |
| Notifications | `UNUserNotificationCenter` local notifications |
| Receive file (rpush) | Save to Files app via configurable destination (e.g., iCloud Drive or On My iPad) |

### Transport Options

The app needs to receive commands from remote hosts via SSH tunnel. Options:

1. **TCP listener** — The app listens on a localhost port. iPad SSH clients forward the remote port to this local port. The daemon-side TCP listener (`127.0.0.1:19876`) and the client-side fallback in `lib/oa.ts` are already implemented, so the iPad app only needs to implement the listener side using the same JSON-over-newline protocol. The port is configurable via `OPEN_AGENT_TCP_PORT` on the remote side. Challenge: iPadOS aggressively suspends background apps, so the listener may not stay alive.

2. **Tailscale direct** — If both iPad and Mac are on the same tailnet, the iPad app could connect directly to the Mac's open-agent. No SSH tunnel needed for this path, but requires Tailscale. The remote client already supports `OPEN_AGENT_TCP_HOST` override, so pointing it at the Mac's Tailscale hostname would work today if the daemon bound to that interface. See [connectivity-plan.md](connectivity-plan.md) for detection and auth details.

3. **Network Extension** — An iOS Network Extension can run in the background and maintain the TCP listener. More complex to implement but solves the suspension problem. Since the app is side-loaded via Xcode (not distributed through the App Store), there are no review constraints on this approach.

4. **Hybrid** — Use the TCP listener when the app is foregrounded. For background delivery, use a lightweight relay (e.g., push notification via a small cloud function) as a fallback.

### File Opening via Files App Providers

Both Secure ShellFish and Blink expose remote filesystems through the iPadOS Files app. The file provider paths follow patterns like:

```
ShellFish/<server-name>/<remote-path>
Blink/<server-name>/<remote-path>
```

The iPad app would:

1. Receive an `open` action with `host` and `path`
2. Map to the appropriate file provider URL (based on which SSH client is in use)
3. Use `UIDocumentInteractionController` to open the file with a compatible app

This requires:
- The remote host is configured in the SSH client (Secure ShellFish or Blink)
- A mapping from open-agent host aliases to the SSH client's server names
- Discovery of which iPadOS apps can handle the file type

### VS Code via Tunnels

For code editing from iPad:

1. Run `code tunnel` on the remote host (creates a persistent tunnel to `vscode.dev`)
2. When the iPad app receives an `open-vscode` action, construct the `vscode.dev` tunnel URL
3. Open in Safari or in Blink's built-in VS Code

The remote `ropen -v` command could detect the iPad environment and output/open the tunnel URL instead of trying to launch a local VS Code instance.

### Shortcuts Integration

The iPad app can expose actions via the Shortcuts app using `AppIntents`:

- "Open URL on remote" — trigger ropen from Shortcuts
- "Copy from remote clipboard" — pull clipboard from a remote session
- "Check agent status" — show active sessions

## Graceful Degradation in Remote Scripts

**Goal**: Remote `r*` commands detect the client environment and adapt behavior.

### Detection Strategy

The remote scripts can detect the environment via:

1. **Agent capability negotiation** — On connect, the agent reports what actions it supports. The iPad agent would report a different capability set than the macOS agent.
2. **Environment variable** — `OPEN_AGENT_CLIENT=ipad` set via SSH `SetEnv`
3. **Terminal detection** — Check `$TERM_PROGRAM` or `$LC_TERMINAL` for Secure ShellFish / Blink signatures

### Fallback Behavior

| Command | macOS agent | iPad agent | No agent |
|---------|------------|------------|----------|
| `ropen file.md` | Open in default app via SSHFS | Open via Files app provider | `xdg-open` / native `open` |
| `ropen url` | Open in browser | Open in Safari | Print URL |
| `ropen -v path` | VS Code remote-ssh | vscode.dev tunnel URL | Print path |
| `rcopy` | pbcopy | UIPasteboard | OSC 52 escape sequence |
| `rpaste` | pbpaste | UIPasteboard | OSC 52 (if supported) |
| `rnotify` | terminal-notifier | Local notification | Print to stderr |
| `rpush` | Save to ~/Downloads | Save to Files app | `scp` / print path |
| `rpull` | Read local file | Not supported (sandboxing) | `scp` / print path |

## Open Questions

- **Background execution**: What's the most reliable way to keep a TCP listener alive on iPadOS? Network Extension is the robust answer but adds implementation complexity. Since this is a personal-use app installed directly from Xcode (no App Store review), private APIs or entitlements are an option if needed.
- **File provider mapping**: How reliable are the Secure ShellFish and Blink file provider paths? Do they change across app updates? Is there a URL scheme we can use instead?
- **SSH client selection**: Both Blink and Secure ShellFish support Files app providers. Should the app auto-detect which client is available, or require a user preference?
