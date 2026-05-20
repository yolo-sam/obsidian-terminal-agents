//
// main.ts — Terminal for Agents (obsidian-terminal-agents).
//
// An Obsidian ItemView hosting a Ghostty terminal pane backed by a Bun PTY
// helper. Agents running in the pane (Claude Code, codex, etc.) receive live
// Obsidian context via env vars + a JSON file the plugin keeps current.
//

import { ItemView, type Menu, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { init as initGhosttyWasm, Terminal } from "ghostty-web";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ContextBridge } from "./context";
import {
	DEFAULT_SETTINGS,
	type TerminalAgentsSettings,
	TerminalAgentsSettingTab,
} from "./settings";

const VIEW_TYPE = "terminal-agents";

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class TerminalAgentsPlugin extends Plugin {
	settings: TerminalAgentsSettings = DEFAULT_SETTINGS;
	private wasmInitPromise: Promise<void> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf, this));

		this.addRibbonIcon("terminal", "Open terminal", () => void this.activate());
		this.addCommand({
			id: "open",
			name: "Open terminal",
			callback: () => void this.activate(),
		});

		this.addSettingTab(new TerminalAgentsSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		// Detaching the leaf triggers the view's onClose, which kills its helper.
		this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<TerminalAgentsSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Lazily load the ghostty-vt WASM. Cached: only loaded once per plugin instance. */
	ensureWasmLoaded(): Promise<void> {
		if (!this.wasmInitPromise) this.wasmInitPromise = initGhosttyWasm();
		return this.wasmInitPromise;
	}

	private async activate(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}
}

// ─── View ─────────────────────────────────────────────────────────────────────

class TerminalView extends ItemView {
	private terminal: Terminal | null = null;
	private helper: ChildProcess | null = null;
	private resizePipe: NodeJS.WritableStream | null = null;
	private contextBridge: ContextBridge | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private termEl: HTMLElement | null = null;
	private charWidth = 9;
	private charHeight = 18;

	constructor(leaf: WorkspaceLeaf, private plugin: TerminalAgentsPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Terminal";
	}
	getIcon(): string {
		return "terminal";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("terminal-agents-container");
		this.termEl = container.createDiv({ cls: "terminal-agents-term" });

		try {
			await this.plugin.ensureWasmLoaded();
		} catch (e) {
			this.fail("Ghostty WASM failed to load", e);
			return;
		}

		this.measureChar();
		this.initTerminal();
		this.spawnHelper();

		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.termEl);
	}

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.killHelper();
		this.contextBridge?.stop();
		this.contextBridge = null;
		this.terminal?.dispose?.();
		this.terminal = null;
	}

	// ── Terminal init ────────────────────────────────────────────────────────

	private initTerminal(): void {
		const fontFamily = "var(--font-monospace), Menlo, Monaco, monospace";
		const fontSize = this.plugin.settings.fontSize;
		// Theme keyed to Obsidian's CSS variables so the terminal matches the
		// active Obsidian theme without parsing the user's Ghostty config.
		const cssVar = (name: string, fallback: string) =>
			getComputedStyle(this.containerEl).getPropertyValue(name).trim() || fallback;
		const theme = {
			background: cssVar("--background-primary", "#1e1e2e"),
			foreground: cssVar("--text-normal", "#cdd6f4"),
			cursor: cssVar("--text-accent", "#f5e0dc"),
		};

		this.terminal = new Terminal({ fontFamily, fontSize, theme });
		this.terminal.open(this.termEl!);
		// Keystrokes → helper stdin → shell.
		this.terminal.onData((data: string) => {
			this.helper?.stdin?.write(data, "utf8");
		});
	}

	private measureChar(): void {
		const probe = this.containerEl.ownerDocument.createElement("canvas");
		const ctx = probe.getContext("2d");
		if (!ctx) return;
		const fontSize = this.plugin.settings.fontSize;
		ctx.font = `${fontSize}px var(--font-monospace), Menlo, Monaco, monospace`;
		const m = ctx.measureText("W");
		this.charWidth = Math.max(1, Math.ceil(m.width));
		const ascent = m.actualBoundingBoxAscent ?? fontSize * 0.8;
		const descent = m.actualBoundingBoxDescent ?? fontSize * 0.2;
		this.charHeight = Math.max(1, Math.ceil((ascent + descent) * 1.2));
	}

	private gridSize(): { cols: number; rows: number } {
		const rect = this.termEl!.getBoundingClientRect();
		return {
			cols: Math.max(10, Math.floor(rect.width / this.charWidth)),
			rows: Math.max(5, Math.floor(rect.height / this.charHeight)),
		};
	}

	// ── Helper process ───────────────────────────────────────────────────────

	private spawnHelper(): void {
		const cwd = this.resolveCwd();
		const env = this.buildEnv(cwd);
		const { argv, extraEnv } = this.buildShellInvocation(env);

		const helperPath = this.helperPath();
		if (!fs.existsSync(helperPath)) {
			this.fail(`helper.ts not found at ${helperPath}`, null);
			return;
		}

		// Obsidian launches with a minimal PATH (e.g. /usr/bin:/bin) that doesn't
		// include $HOME/.bun/bin or Homebrew. Resolve bun via known locations so
		// the user doesn't have to symlink it into /usr/local/bin.
		const bunPath = resolveBun(env);
		if (!bunPath) {
			this.fail(
				"Bun executable not found. Install Bun (https://bun.sh) — it's the runtime for the PTY helper.",
				null,
			);
			return;
		}

		const augmentedEnv = {
			...env,
			...extraEnv,
			PATH: [path.dirname(bunPath), env.PATH].filter(Boolean).join(path.delimiter),
		};

		const { cols, rows } = this.gridSize();
		try {
			this.helper = spawn(bunPath, [helperPath, ...argv], {
				cwd,
				env: augmentedEnv,
				stdio: ["pipe", "pipe", "inherit", "pipe"],
			});
		} catch (e) {
			this.fail("Failed to spawn Bun helper", e);
			return;
		}

		// stdio matches the spawn arg above: [stdin, stdout, stderr, fd3-resize]
		const stdio = this.helper.stdio as unknown as [
			NodeJS.WritableStream,
			NodeJS.ReadableStream,
			NodeJS.WritableStream,
			NodeJS.WritableStream,
		];
		if (!stdio[3]) {
			this.fail("Helper stdio[3] (resize pipe) missing — child process spawned with wrong stdio config", null);
			this.killHelper();
			return;
		}
		this.resizePipe = stdio[3];

		this.helper.stdout?.on("data", (buf: Buffer) => {
			this.terminal?.write(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
		});
		this.helper.on("close", (code) => {
			this.terminal?.write(`\r\n\x1b[33m[Process exited with code ${code ?? 0}. Reopen the pane to restart.]\x1b[0m\r\n`);
			this.helper = null;
			this.resizePipe = null;
		});
		this.helper.on("error", (err) => this.fail("Helper error", err));

		// Send initial size before the shell prints its first prompt.
		this.sendResize(rows, cols);

		// Context bridge — only if enabled.
		if (this.plugin.settings.shareObsidianContext) {
			this.contextBridge = new ContextBridge(this.app, env.OBSIDIAN_CONTEXT_FILE);
			this.contextBridge.start();
		}
	}

	private killHelper(): void {
		const proc = this.helper;
		if (!proc) return;
		try {
			proc.stdin?.end();
		} catch {
			/* ignore */
		}
		try {
			proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		this.helper = null;
		this.resizePipe = null;
	}

	private handleResize(): void {
		const { cols, rows } = this.gridSize();
		this.terminal?.resize(cols, rows);
		this.sendResize(rows, cols);
	}

	private sendResize(rows: number, cols: number): void {
		if (!this.resizePipe) return;
		const frame = Buffer.alloc(4);
		frame.writeUInt16BE(rows, 0);
		frame.writeUInt16BE(cols, 2);
		try {
			this.resizePipe.write(frame);
		} catch {
			/* helper may have just died */
		}
	}

	// ── Spawn config ─────────────────────────────────────────────────────────

	private resolveCwd(): string {
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const vaultRoot = adapter.getBasePath?.() ?? os.homedir();
		const settings = this.plugin.settings;
		if (settings.agentScope === "custom" && settings.customScopePath) {
			// Fall back to vault root if the custom path is unreachable so the
			// terminal opens somewhere usable instead of failing the spawn.
			if (isUsableDir(settings.customScopePath)) return settings.customScopePath;
			new Notice(
				`Custom scope path "${settings.customScopePath}" is unreachable — falling back to vault root.`,
				6000,
			);
		}
		if (settings.agentScope === "activeNoteFolder") {
			const file = this.app.workspace.getActiveFile();
			if (file) return path.join(vaultRoot, path.dirname(file.path));
		}
		return vaultRoot;
	}

	private buildEnv(cwd: string): Record<string, string> {
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const vaultRoot = adapter.getBasePath?.() ?? os.homedir();
		const vaultName = this.app.vault.getName();
		const contextFile = path.join(
			os.tmpdir(),
			"obs-terminal-agents",
			sanitize(vaultName),
			"context.json",
		);
		fs.mkdirSync(path.dirname(contextFile), { recursive: true });

		return {
			...(process.env as Record<string, string>),
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			TERM_PROGRAM: "obsidian-terminal-agents",
			OBSIDIAN_VAULT: vaultRoot,
			// Strip control chars and surrounding quotes/backslashes from the vault
			// name — it lands in the agent's system prompt as text, and we don't
			// want a clever vault name to break out of that string.
			OBSIDIAN_VAULT_NAME: sanitizeForPrompt(vaultName),
			OBSIDIAN_CONTEXT_FILE: contextFile,
			OBSIDIAN_CWD: cwd,
		};
	}

	/**
	 * Pick the right shell invocation per shell type and wire shellrc.sh in.
	 * Bash → `--rcfile <stub>` that sources ~/.bashrc then ours.
	 * Zsh  → `ZDOTDIR=<stub-dir>` containing a .zshrc that does the same.
	 * Other → spawn the shell raw; user gets the env vars but no obs-ctx alias.
	 */
	private buildShellInvocation(env: Record<string, string>): {
		argv: string[];
		extraEnv: Record<string, string>;
	} {
		const shell = this.plugin.settings.defaultShell || env.SHELL || "/bin/zsh";
		const shellName = path.basename(shell);

		if (!this.plugin.settings.shareObsidianContext) {
			return { argv: [shell, "-i"], extraEnv: {} };
		}

		// Stage shellrc in a tmp dir keyed to the vault so concurrent vaults don't
		// trample each other. The source ships alongside the plugin (rather than
		// being bundled into main.js) so it's editable on disk for debugging.
		const stageDir = path.join(
			os.tmpdir(),
			"obs-terminal-agents",
			sanitize(env.OBSIDIAN_VAULT_NAME ?? "default"),
			"rc",
		);
		fs.mkdirSync(stageDir, { recursive: true });
		const rcSrc = this.readShellrc();
		const rcPath = path.join(stageDir, "shellrc.sh");
		fs.writeFileSync(rcPath, rcSrc);

		if (shellName === "bash") {
			const stub = path.join(stageDir, "bashrc-stub");
			fs.writeFileSync(stub, `[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n. "${rcPath}"\n`);
			return { argv: [shell, "--rcfile", stub, "-i"], extraEnv: {} };
		}
		if (shellName === "zsh") {
			// zsh reads .zshenv → .zshrc from ZDOTDIR when set. We need to defer to
			// the user's real $HOME files for both, otherwise PATH/EDITOR/etc set in
			// their .zshenv gets dropped.
			const zenv = path.join(stageDir, ".zshenv");
			fs.writeFileSync(zenv, `[ -f "$HOME/.zshenv" ] && . "$HOME/.zshenv"\n`);
			const zrc = path.join(stageDir, ".zshrc");
			fs.writeFileSync(zrc, `[ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc"\n. "${rcPath}"\n`);
			return { argv: [shell, "-i"], extraEnv: { ZDOTDIR: stageDir } };
		}
		// Unknown shell — context env vars still set, but no obs-ctx wrapper.
		return { argv: [shell, "-i"], extraEnv: {} };
	}

	private helperPath(): string {
		return this.pluginFile("helper.ts");
	}

	private readShellrc(): string {
		const p = this.pluginFile("shellrc.sh");
		try {
			return fs.readFileSync(p, "utf8");
		} catch {
			return "";
		}
	}

	private pluginFile(name: string): string {
		const manifestDir = this.plugin.manifest.dir;
		const adapter = this.app.vault.adapter as unknown as { getFullPath?: (p: string) => string };
		if (manifestDir && adapter.getFullPath) {
			return adapter.getFullPath(`${manifestDir}/${name}`);
		}
		return path.join(__dirname, name);
	}

	// ── Error helper ─────────────────────────────────────────────────────────

	private fail(msg: string, err: unknown): void {
		const detail = err instanceof Error ? err.message : err ? String(err) : "";
		const full = detail ? `${msg}: ${detail}` : msg;
		console.error("[terminal-agents]", full);
		new Notice(`Terminal: ${full}`, 8000);
		this.terminal?.write(`\x1b[31m${full}\x1b[0m\r\n`);
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitize(s: string): string {
	return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64) || "default";
}

/** Make a string safe to embed as a literal in a system-prompt sentence. */
function sanitizeForPrompt(s: string): string {
	// Drop control chars, ASCII quotes, and backslashes. Keep CJK/emoji/spaces.
	return s.replace(/[\x00-\x1f"'\\`]/g, "").slice(0, 200) || "vault";
}

function isUsableDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Find Bun across PATH plus the common install locations Obsidian misses. */
function resolveBun(env: Record<string, string>): string | null {
	const candidates: string[] = [];
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (dir) candidates.push(path.join(dir, "bun"));
	}
	const home = env.HOME || os.homedir();
	candidates.push(
		path.join(home, ".bun/bin/bun"),
		"/opt/homebrew/bin/bun",
		"/usr/local/bin/bun",
	);
	for (const cand of candidates) {
		try {
			if (fs.existsSync(cand)) return cand;
		} catch {
			/* keep looking */
		}
	}
	return null;
}
