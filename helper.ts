#!/usr/bin/env bun
//
// helper.ts — minimal Bun PTY proxy for Obsidian plugin.
//
// argv: <shell-path> [shell-args...]
//
// Protocol with the plugin (parent process):
//
//   parent stdin  → helper stdin  → terminal.write()   (keystrokes)
//   terminal data → helper stdout → parent stdout      (rendered bytes)
//   parent fd 3   → 4-byte frames (uint16 rows, uint16 cols) → terminal.resize()
//   parent closes stdin → helper kills shell and exits
//
// cwd and env are inherited from the parent at spawn time.
// PTY backend: Bun.Terminal (Bun 1.3+, POSIX only).

import { createReadStream } from "node:fs";

const shell = process.argv[2];
if (!shell) {
	console.error("Usage: helper.ts <shell-path> [shell-args...]");
	process.exit(2);
}
const shellArgs = process.argv.slice(3);

const terminal = new Bun.Terminal({
	cols: 80,
	rows: 24,
	name: "xterm-256color",
	data(_term, data) {
		process.stdout.write(data);
	},
});

const proc = Bun.spawn([shell, ...shellArgs], {
	terminal,
	env: process.env as Record<string, string>,
});

process.stdin.on("data", (chunk: Buffer) => {
	terminal.write(chunk);
});

process.stdin.on("end", () => {
	terminal.close();
	proc.kill("SIGTERM");
	process.exit(0);
});

// fd 3: resize frames. 4 bytes per frame: uint16 rows, uint16 cols, big-endian.
// Chunks may pack multiple frames; loop in steps of 4.
const resizeStream = createReadStream("", { fd: 3, autoClose: false });
resizeStream.on("data", (chunk: Buffer) => {
	for (let i = 0; i + 4 <= chunk.length; i += 4) {
		const rows = chunk.readUInt16BE(i);
		const cols = chunk.readUInt16BE(i + 2);
		if (rows > 0 && cols > 0) terminal.resize(cols, rows);
	}
});
resizeStream.on("error", () => {
	// fd 3 missing or closed early — non-fatal; terminal stays at default size
	// until plugin reopens it.
});

proc.exited.then((code) => {
	process.exit(typeof code === "number" ? code : 0);
});
