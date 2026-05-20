# Handoff — Terminal for Agents

> For the next agent (or human) picking this up. Skim the top sections; drill into the linked deeper docs only when you need them.

## What this is in one paragraph

An Obsidian plugin that opens a real Ghostty terminal pane in your vault and shares Obsidian workspace state with whatever agent runs inside that shell. Forked from `lavs9/obsidian-ghostty-terminal` and stripped to ~6 source files. v0.1.0 ships ~30 May 2026 against Obsidian 1.7.2+. macOS/Linux only.

## Status as of handoff

- ✅ End-to-end working in Sam's vault (built, sideloaded, terminal renders, shell spawns, `obs-ctx` resolves vault path).
- ✅ Forked to `yolo-sam/obsidian-terminal-agents`.
- ✅ PR open against fork's `main` from `claude/v1-strip-and-bun` (see PR for review state).
- ⚠️ Manual smoke test only — no automated tests yet.
- ⚠️ Screenshots in `docs/images/` are canvas dumps, not full app screenshots. Replace with proper UI screenshots before public release.
- ⚠️ Repo is under the `yolo-sam` GitHub org because that's where `gh auth status` was logged in. If Sam wants it under `smcllns/` instead, transfer via `gh api -X POST /repos/yolo-sam/obsidian-terminal-agents/transfer -f new_owner=smcllns` (requires push rights on both).

## How to start from cold

```sh
git clone https://github.com/yolo-sam/obsidian-terminal-agents ~/Projects/obsidian-terminal-agents
cd ~/Projects/obsidian-terminal-agents
bun install
bun run build                          # writes main.js

# Sideload into the test vault
PLUGIN_DIR=~/Projects/obsidian/.obsidian/plugins/obsidian-terminal-agents
mkdir -p "$PLUGIN_DIR"
cp main.js manifest.json styles.css helper.ts shellrc.sh "$PLUGIN_DIR"/

# Enable in Obsidian
obsidian-cli plugin:enable id=obsidian-terminal-agents
obsidian-cli eval code="this.app.commands.executeCommandById('obsidian-terminal-agents:open')"
```

Iteration loop while developing:

```sh
bun run dev    # watch + rebuild on save
# then in obsidian-cli:
obsidian-cli plugin:reload id=obsidian-terminal-agents
```

To test the helper standalone (no Obsidian):

```sh
bun helper.ts /bin/zsh    # then type, Ctrl-D to close
```

## File map

```
main.ts        ~280 lines  plugin class + ItemView + shell invocation
helper.ts      ~50 lines   Bun PTY proxy (runs as child process)
context.ts    ~110 lines   ContextBridge — workspace events → JSON file
settings.ts   ~110 lines   settings interface + tab UI (4 controls)
shellrc.sh     ~30 lines   obs-ctx + claude wrapper, sourced by bash/zsh
styles.css     ~25 lines
manifest.json
package.json
tsconfig.json
bunfig.toml
```

## Key choices and the reasoning

Read the linked sections only if you're about to change something here. Otherwise skim and move on.

### Why Bun for the PTY helper

Picked over `node-pty` (the dominant Electron approach) because `node-pty` is a native addon that breaks on every Electron upgrade and forces users to run `electron-rebuild`. Bun 1.3+ has a built-in PTY (`Bun.spawn({ terminal: … })`) that's POSIX-native, no addons. Cost: users need Bun on PATH. Sam already has it. The plugin resolves `bun` via `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, and `$PATH`, so Obsidian's stripped launch PATH isn't an issue.

If you ever need to drop the Bun dependency: easiest swap is `node-pty-prebuilt-multiarch` (which the upstream used) or ship a tiny Python `pty` helper (what lavs9 did). Both work; both cost more than the Bun path.

### Why a JSON snapshot file (not a server)

The spec considered an MCP server inside the plugin. v1 picked the file because:
- Zero ports/sockets, no permission prompts.
- Works for any agent / any tool that can `cat` a file.
- The `claude --append-system-prompt` wrapper just tells Claude where to look; Claude does the read.

The MCP path is better long-term (bidirectional ops, push notifications), but it's strictly more complex. v1 ships the simpler thing. See [Roadmap](#what-i-would-build-next) for the upgrade path.

### Why Ghostty over xterm.js

Forked from a Ghostty-based plugin so the choice was made for me. But the right call: ghostty-web is `libghostty-vt` compiled to WASM — same VT parser as the native Ghostty app. Proper Unicode (grapheme clusters, wide chars), OSC 8, Kitty graphics. xterm.js approximates these; Ghostty just does them. WASM is ~700KB inlined into `main.js`; load is lazy (only when the user first opens the terminal pane).

### Why the shellrc is read from disk at spawn, not bundled

I initially tried `bun build --loader:.sh=text` but the CLI doesn't support that flag (the JS API does). Pivoted to: ship `shellrc.sh` alongside the plugin and `fs.readFileSync` it at spawn time. Benefits: editable on disk for debugging without rebuilding; smaller `main.js`; the shellrc lives where you'd expect it. Cost: one extra file in the release artifact.

### Why bash/zsh get a `--rcfile` / `ZDOTDIR` stub instead of `source`-ing inline

Need to source the user's own `.bashrc`/`.zshrc` AND ours, without breaking their config. The stub does `[ -f ~/.zshrc ] && . ~/.zshrc` then our rc. For zsh specifically, you can't pass `--rcfile`, so we set `ZDOTDIR=<stage-dir>` and put a `.zshrc` there. This is the cleanest way to layer a shellrc without modifying the user's home files.

Other shells (fish, nushell, …) currently spawn raw — they get the `OBSIDIAN_*` env vars but no `obs-ctx` alias. Add cases to `buildShellInvocation` in `main.ts` if/when those become priorities.

### Why the resize protocol uses fd 3 (not inline)

The shell's PTY needs to know its row/col grid. Plugin computes this from the pane's pixel dimensions. Sending it inline on stdin would conflict with keystroke bytes. fd 3 is a separate pipe; helper reads 4-byte big-endian frames (uint16 rows, uint16 cols). Simple, no ambiguity.

### Why we don't parse `~/.config/ghostty/config`

Upstream did; v1 doesn't, on purpose. The terminal renders with Obsidian's CSS variables (`--background-primary`, `--text-normal`, `--text-accent`) so it auto-themes with the rest of the editor. If the user wants Ghostty's exact look, they can run native Ghostty next to Obsidian — that's the legacy setup we're replacing.

Re-introducing this is straightforward (lavs9's `src/ghostty-config.ts` is in upstream's git history) but the test surface explodes (font fallback, keybind translation, theme merging). Defer until users actually ask.

### Why one terminal pane (not multi)

Spec says single instance. Reasoning: most users will pin one terminal in a sidebar and live in it via tmux. Multi-pane adds workspace event scoping (which pane gets which context?) and keyboard focus management — both non-trivial. v1 makes it easy to get the canonical case right; v2 can add per-pane terminals with their own context once we understand the usage pattern.

## How to debug

When something doesn't work, in order of likelihood:

1. **Plugin doesn't load**: check `obsidian-cli dev:console` for stack traces. If `main.js` looks corrupt, rebuild with `bun run build`.
2. **Terminal renders blank**: check the canvas exists in DOM:
   ```js
   obsidian-cli eval code="const v=this.app.workspace.getLeavesOfType('terminal-agents')[0].view; ({ hasCanvas: !!v.containerEl.querySelector('canvas'), helperPid: v.helper?.pid })"
   ```
   If `helperPid` is null, helper failed to spawn — check Bun is reachable.
3. **`obs-ctx: command not found`**: the shellrc didn't source. Check `$ZDOTDIR/.zshrc` exists in the stage dir (`/tmp/obs-terminal-agents/<vault>/rc/`) and points at a non-empty `shellrc.sh`. If `shellrc.sh` is empty, the read-from-disk path is wrong — check `manifest.dir` resolves.
4. **Context file not updating**: stop the terminal, watch the file with `tail -F`, reopen. `ContextBridge.start()` should write immediately on open and then on every workspace event. If only the initial write happens, the event subscriptions failed (check the `EventRef` retains, `offref` was called too early, or Obsidian deprecated the event names).
5. **Resize doesn't track**: `ResizeObserver` fires `handleResize` which both updates `terminal.resize(cols, rows)` AND sends fd 3 frame to helper. Either side could break. Helper has no logs; add a `console.error` to debug.

For a no-Obsidian smoke test of the helper:

```sh
echo -ne '\x00\x18\x00\x50' | bun helper.ts /bin/sh  # 24 rows × 80 cols
```

(That sends one resize frame on stdin, which is wrong — the spec is fd 3, not stdin. Sorry; instrument helper.ts to log frame receipts if you need to verify the resize wiring end-to-end.)

## What I would build next if I had more time

In rough priority (I'd start at the top):

### 1. Replace the JSON file with an MCP server inside the plugin

The file approach works but is pull-only. An MCP server lets Claude Code (and any future MCP-aware agent) subscribe to context updates and call back into Obsidian — "focus this tab", "open this file", "search the vault". The plugin already has the workspace API; we'd just expose it over stdio MCP. Two reasons this matters: (a) bidirectional means the agent can drive Obsidian, not just observe it, which is the whole reason embedded terminals beat external ones, and (b) push beats poll for latency.

Reference shape: plugin spawns an MCP server child process (Bun, same pattern as helper.ts), exposes it via `MCP_TRANSPORT_STDIO` env var + a port. Claude Code auto-detects MCP servers.

### 2. Selection / cursor position in the context

`active-leaf-change` fires on tab switches but not on cursor movement. For "edit this paragraph"-style requests, the agent needs to know which paragraph. Subscribe to `editor-change` (or poll `editor.getCursor()` on a 200ms timer) and include `cursor: { line, ch }` + `selection: string` in the snapshot. Skip if cursor is in a non-markdown view.

### 3. Per-leaf terminal context scoping

Right now one global context file. If you open two terminal panes, both see the same snapshot. Cleaner model: each pane gets its own context file scoped to whatever workspace branch it lives in (e.g. the parent split's most-recently-active editor). This is mostly UX policy — the implementation is straightforward (per-view `ContextBridge` with per-view JSON path) but the policy needs Sam's input on what "context" means when you have multiple panes.

### 4. Tests

Currently no automated tests at all. Minimum I'd add:
- A standalone test for `helper.ts` (spawn, send command, read output, send resize, EOF) — already prototyped in the Bash session that wrote the helper; lift into `test/helper.test.ts`.
- A snapshot test for `buildSnapshot()` in `context.ts` with a mocked `app.workspace`.
- A build-artifact test: `main.js` exists, is < 1MB, contains no `process.env` strings beyond expected ones (catches accidentally-shipped secrets).

### 5. Settings UX polish

The "Default shell" field accepts any string. Should validate the path exists. The "Custom scope path" field has the same issue. Both should show inline errors and refuse to save invalid values.

### 6. Windows support

Bun PTY is POSIX-only. Windows would need `node-pty-prebuilt-multiarch` or ConPTY directly. Probably not worth the maintenance load unless there's user demand.

## Useful things to know that aren't obvious from the code

- **Obsidian's PATH at launch is minimal** — `/usr/bin:/bin:/usr/sbin:/sbin`. Anything in `~/.bun/bin`, `/opt/homebrew/bin`, or `/usr/local/bin` is invisible. `resolveBun()` handles this for Bun specifically; the spawned shell's PATH gets the Bun directory prepended. If you add another tool dependency, follow the same pattern.
- **`os.tmpdir()` returns a long macOS-specific path**, not `/tmp`. The stage dir lives there. If you're looking for the context file: `obsidian-cli eval code="require('os').tmpdir()"` then `find $TMPDIR -name 'obs-terminal-agents' -type d`.
- **`workspace.activeLeaf` can be null** when no leaf has focus. The snapshot writes `activeTab: null` in that case. Some agents will need to handle that; the README docs the schema.
- **Reading the ghostty-web canvas as a PNG works**: `canvas.toDataURL('image/png')` then base64-decode. Useful for screenshots that don't depend on Obsidian's screenshot mechanism (which captures the whole window, often without the terminal visible).
- **The fork ships with upstream's `.beads/` removed** — it's an issue-tracking tool we don't use. Don't re-add it; we picked an external tracker if needed (GitHub Issues on the fork).

## Pointers to deeper context

- Spec (canonical intent for v1): `~/Projects/obsidian-ghostty-min-spec.md`
- Upstream we forked: https://github.com/lavs9/obsidian-ghostty-terminal
- ghostty-web (the WASM VT): https://github.com/ghostty-org/ghostty
- Bun PTY API: `node_modules/bun-types/bun.d.ts` — search for `terminal?: TerminalOptions`.
- Obsidian plugin API: https://docs.obsidian.md/Plugins
- The conversation that produced this plugin lives in Sam's vault at `scratch/I want each pi instance to be able to display its own browser tab.md` — includes the Option 1-4 tradeoff discussion.

## Last note to the next agent

The point of this plugin is not "another terminal in another editor." It's "the agent in your terminal should know which tab you're staring at." Every design decision flows from that. If you find yourself adding a feature that doesn't move the agent-context story forward, ask whether it belongs here or in a fancier fork.

Also — keep this small. The upstream got to 600 lines of `main.ts` because every Ghostty-config knob got plumbed in. v1 fits in ~280 lines because we deferred all of that. Resist scope creep.
