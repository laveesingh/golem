#!/usr/bin/env bash
# _golem-home.sh — bash mirror of lib/golem-home.js (TKT-0573, ADR-4). Sourced
# by journal-route.sh, notify.sh, session-register.sh. This file runs from the
# INSTALLED plugin copy (${CLAUDE_PLUGIN_ROOT}), so it cannot `source` the repo
# module directly — keep the resolution order in sync by hand if either side
# changes.
#
# Resolution order (same as lib/golem-home.js):
#   1. $GOLEM_HOME          — explicit override.
#   2. $XDG_CONFIG_HOME      — legacy override (test isolation); outranks the
#      ~/.golem auto-detect so isolated runs never leak into production state.
#   3. ~/.golem             — once it exists as a real directory (not a
#      symlink — a symlink there IS the old path, handled by falling through
#      to case 4, which resolves through it transparently).
#   4. ~/.config/golem      — pre-migration default.
#
# Sets GOLEM_HOME_DIR. Safe under `set -u`.

# Native Claude path mirror of lib/claude-paths.js.
CLAUDE_CONFIG_DIR_RESOLVED="${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}"

if [ -n "${GOLEM_HOME:-}" ]; then
  GOLEM_HOME_DIR="$GOLEM_HOME"
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  GOLEM_HOME_DIR="$XDG_CONFIG_HOME/golem"
elif [ -d "$HOME/.golem" ]; then
  GOLEM_HOME_DIR="$HOME/.golem"
else
  GOLEM_HOME_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/golem"
fi
