import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import * as fs from "node:fs";
import type TerminalAgentsPlugin from "./main";

export type AgentScope =
	| { kind: "vault" }
	| { kind: "activeNoteFolder" }
	| { kind: "custom"; path: string };

export interface TerminalAgentsSettings {
	defaultShell: string;
	fontSize: number;
	agentScope: "vault" | "activeNoteFolder" | "custom";
	customScopePath: string;
	shareObsidianContext: boolean;
}

export const DEFAULT_SETTINGS: TerminalAgentsSettings = {
	defaultShell: "",
	fontSize: 13,
	agentScope: "vault",
	customScopePath: "",
	shareObsidianContext: true,
};

function isExistingDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export class TerminalAgentsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: TerminalAgentsPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default shell")
			.setDesc("Absolute path of the shell to spawn. Leave blank to use $SHELL.")
			.addText((text) =>
				text
					.setPlaceholder(process.env.SHELL || "/bin/zsh")
					.setValue(this.plugin.settings.defaultShell)
					.onChange(async (value) => {
						this.plugin.settings.defaultShell = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Terminal font size in pixels.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.fontSize))
					.onChange(async (value) => {
						const n = Number.parseInt(value, 10);
						if (Number.isFinite(n) && n > 0) {
							this.plugin.settings.fontSize = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Agent scope")
			.setDesc("Working directory the shell opens in. Agents (Claude Code, etc.) read this as their root.")
			.addDropdown((dd) =>
				dd
					.addOption("vault", "Vault root")
					.addOption("activeNoteFolder", "Folder of the active note")
					.addOption("custom", "Custom path")
					.setValue(this.plugin.settings.agentScope)
					.onChange(async (value) => {
						this.plugin.settings.agentScope = value as TerminalAgentsSettings["agentScope"];
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.agentScope === "custom") {
			new Setting(containerEl)
				.setName("Custom scope path")
				.setDesc("Absolute path. Used when Agent scope is Custom. Must be an existing directory.")
				.addText((text) =>
					text
						.setValue(this.plugin.settings.customScopePath)
						.onChange(async (value) => {
							const trimmed = value.trim();
							if (trimmed && !isExistingDir(trimmed)) {
								new Notice(`"${trimmed}" is not an existing directory — value not saved.`, 5000);
								return;
							}
							this.plugin.settings.customScopePath = trimmed;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Share Obsidian context with terminal")
			.setDesc(
				"When ON, the plugin writes the active tab and open tabs to a JSON file and sets OBSIDIAN_* env vars in the shell. Agents in the pane can read it for live workspace awareness.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.shareObsidianContext)
					.onChange(async (value) => {
						this.plugin.settings.shareObsidianContext = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
