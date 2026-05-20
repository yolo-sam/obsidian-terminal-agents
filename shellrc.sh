# shellrc.sh — sourced by interactive bash/zsh spawned inside the
# Obsidian terminal pane. Provides:
#
#   obs-ctx [jq-filter]  — prints current Obsidian context JSON
#   claude (override)    — wraps Claude Code with --append-system-prompt
#                          telling it about the vault + context file
#
# These rely on env vars set by the plugin at spawn:
#   $OBSIDIAN_VAULT          — absolute vault path (also the shell cwd)
#   $OBSIDIAN_VAULT_NAME     — vault display name
#   $OBSIDIAN_CONTEXT_FILE   — path to the live JSON snapshot

obs-ctx() {
	if [ ! -f "$OBSIDIAN_CONTEXT_FILE" ]; then
		echo "obs-ctx: context file not found (\$OBSIDIAN_CONTEXT_FILE=$OBSIDIAN_CONTEXT_FILE)" >&2
		return 1
	fi
	if command -v jq >/dev/null 2>&1; then
		jq "${1:-.}" "$OBSIDIAN_CONTEXT_FILE"
	else
		cat "$OBSIDIAN_CONTEXT_FILE"
	fi
}

# Wrap `claude` so every agent invocation inside this pane knows where it is.
# Uses `command claude` to avoid recursion. Skips wrapping if claude isn't on PATH.
if command -v claude >/dev/null 2>&1; then
	claude() {
		command claude --append-system-prompt "You are running inside the Obsidian vault \"$OBSIDIAN_VAULT_NAME\" at $OBSIDIAN_VAULT. The user's live Obsidian context (active tab, open tabs) is in JSON at $OBSIDIAN_CONTEXT_FILE — read it any time you need to know what they're looking at." "$@"
	}
fi
