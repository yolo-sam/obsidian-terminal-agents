//
// context.ts — Obsidian → agent context bridge.
//
// Writes a JSON snapshot of the workspace state (active tab, open tabs, vault
// info) to a file the shell-side helper can `cat $OBSIDIAN_CONTEXT_FILE`.
// Updates on `active-leaf-change` and `layout-change`, atomically debounced.
//

import { type App, type EventRef, type FileView, type WorkspaceLeaf } from "obsidian";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEBOUNCE_MS = 100;
const RELEVANT_VIEW_TYPES = new Set(["markdown", "html"]);

export interface ContextSnapshot {
	updatedAt: number;
	vault: { name: string; path: string };
	activeTab: TabInfo | null;
	openTabs: TabInfo[];
}

interface TabInfo {
	leafId: string;
	path: string;
	type: string;
	title: string;
	isActive: boolean;
	isPinned: boolean;
}

export class ContextBridge {
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private subscriptions: EventRef[] = [];

	constructor(
		private app: App,
		private contextFilePath: string,
	) {}

	start(): void {
		fs.mkdirSync(path.dirname(this.contextFilePath), { recursive: true });
		this.subscriptions.push(
			this.app.workspace.on("active-leaf-change", () => this.scheduleWrite()),
			this.app.workspace.on("layout-change", () => this.scheduleWrite()),
		);
		this.writeNow();
	}

	stop(): void {
		for (const ref of this.subscriptions) this.app.workspace.offref(ref);
		this.subscriptions = [];
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = null;
	}

	private scheduleWrite(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => this.writeNow(), DEBOUNCE_MS);
	}

	private writeNow(): void {
		const snapshot = this.buildSnapshot();
		// Atomic write: tmp → rename, so a partial read never sees half a JSON.
		const tmp = `${this.contextFilePath}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
		fs.renameSync(tmp, this.contextFilePath);
	}

	private buildSnapshot(): ContextSnapshot {
		const workspace = this.app.workspace;
		const activeLeaf = workspace.activeLeaf;
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const vaultPath = adapter.getBasePath?.() ?? os.homedir();

		const openTabs: TabInfo[] = [];
		let activeTab: TabInfo | null = null;
		workspace.iterateAllLeaves((leaf) => {
			const info = leafToTabInfo(leaf, activeLeaf);
			if (!info) return;
			openTabs.push(info);
			if (info.isActive) activeTab = info;
		});

		return {
			updatedAt: Math.floor(Date.now() / 1000),
			vault: { name: this.app.vault.getName(), path: vaultPath },
			activeTab,
			openTabs,
		};
	}
}

function leafToTabInfo(leaf: WorkspaceLeaf, activeLeaf: WorkspaceLeaf | null): TabInfo | null {
	const view = leaf.view as FileView & { getDisplayText?: () => string };
	const type = view.getViewType?.() ?? "";
	if (!RELEVANT_VIEW_TYPES.has(type)) return null;
	const filePath = view.file?.path;
	if (!filePath) return null;
	return {
		leafId: (leaf as unknown as { id?: string }).id ?? "",
		path: filePath,
		type,
		title: view.getDisplayText?.() ?? filePath,
		isActive: leaf === activeLeaf,
		isPinned: (leaf as unknown as { pinned?: boolean }).pinned === true,
	};
}
