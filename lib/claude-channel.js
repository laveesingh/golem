// claude-channel — how golem loads its channel into Claude Code, shared by the
// `golem claude` launcher and managed Claude spawns (GOL-382 R11).

export const CLAUDE_CHANNEL_FLAG = '--dangerously-load-development-channels';
export const GOLEM_CLAUDE_CHANNEL = 'plugin:golem@golem-workspace';

// Claude asks to confirm a development channel before the session starts.
// golem answers only for agents it starts itself, and only when the screen
// names exactly golem's own channel with option 1 selected (human decision
// 1a, 2026-09-24). Pane text wraps at any character, so the match ignores
// all whitespace.
const PROMPT_PARTS = [
  'Loading development channels',
  `Channels: ${GOLEM_CLAUDE_CHANNEL}`,
  '❯ 1. I am using this for local development',
].map((part) => part.replace(/\s+/g, ''));

/** True when the pane shows Claude's dev-channel prompt for golem's channel only. */
export function isGolemDevChannelPrompt(paneText) {
  const flat = String(paneText ?? '').replace(/\s+/g, '');
  if (!PROMPT_PARTS.every((part) => flat.includes(part))) return false;
  // Exactly one channel is named: a second plugin in the list is not ours to accept.
  const channels = flat.slice(flat.lastIndexOf('Channels:') + 'Channels:'.length).split('❯')[0];
  return channels === GOLEM_CLAUDE_CHANNEL;
}
