// Advisory policy evidence, separate from initialization and transport results.
// No provider URLs, credentials, timestamps or per-tick logging in diagnostics.
import { SUPPORTED_PI_VERSION } from './pi-compatibility.js';
const warning = (code, message, details = {}) => ({ code, severity: 'warning', message, ...details });
const providerReasons = new Map([
  ['unsupported_bedrock_provider', 'bedrock'], ['unsupported_vertex_provider', 'vertex'],
  ['unsupported_foundry_provider', 'foundry'], ['unsupported_custom_base_url', 'custom-base-url'],
]);
export function claudeProviderCompatibility(env = process.env) {
  const providers = [];
  for (const [flag, provider] of [['CLAUDE_CODE_USE_BEDROCK', 'bedrock'], ['CLAUDE_CODE_USE_VERTEX', 'vertex'], ['CLAUDE_CODE_USE_FOUNDRY', 'foundry']]) {
    if (String(env[flag] ?? '').trim() === '1') providers.push(provider);
  }
  const base = String(env.ANTHROPIC_BASE_URL ?? '').trim().replace(/\/+$/, '').toLowerCase();
  if (base && base !== 'https://api.anthropic.com') providers.push('custom-base-url');
  return { status: providers.length ? 'unverified' : 'supported', warnings: providers.map(provider => warning(
    'CLAUDE_CHANNEL_PROVIDER_UNVERIFIED', `Claude channel support for ${provider} is unverified; attempting normal delivery after MCP initialization.`, { provider })) };
}
export function claudeConsumerStatus({ initialized, env = process.env } = {}) {
  return { initialized: initialized === true, ready: initialized === true,
    reason: initialized === true ? null : 'mcp_not_initialized', transport: 'claude-channel', compatibility: claudeProviderCompatibility(env) };
}
export async function submitClaudeChannelNotification({ initialized, env = process.env, notification, content, meta } = {}) {
  const consumer = claudeConsumerStatus({ initialized, env });
  if (!consumer.ready) {
    const error = new Error('Claude Code channel is not ready because MCP initialization has not completed. Wait for plugin startup or restart the channel-enabled session.');
    error.statusCode = 503; error.failureStage = 'before_native'; throw error;
  }
  // Native rejection/write/protocol errors propagate unchanged. Submission is
  // not an invented native receipt or proof the host consumed the notification.
  await notification({ method: 'notifications/claude/channel', params: { content, meta } });
  return consumer.compatibility.warnings;
}
export function channelCompatibilityWarnings(channel) {
  const current = Array.isArray(channel?.compatibility?.warnings) ? channel.compatibility.warnings : [];
  const provider = providerReasons.get(channel?.consumer_reason);
  const legacyPolicy = String(channel?.consumer_reason ?? '').startsWith('unsupported_');
  return dedupeWarnings([...current, ...(legacyPolicy ? [warning(provider ? 'CLAUDE_CHANNEL_PROVIDER_UNVERIFIED' : 'LEGACY_CHANNEL_COMPATIBILITY_POLICY',
    'Legacy channel compatibility metadata is advisory; initialization and actual endpoint results determine delivery.', { ...(provider ? { provider } : {}), legacy_metadata: true })] : [])]);
}
export function claudeChannelDeliveryReady(channel) {
  // Explicit init evidence wins over legacy compatibility-derived booleans.
  // A legacy supported ready signal proves init; unsupported reason alone
  // does not. Unknown old-process init remains a truthful restart limitation.
  const initialized = typeof channel?.consumer_initialized === 'boolean' ? channel.consumer_initialized : channel?.consumer_ready === true;
  if (!initialized || channel?.consumer_reason === 'mcp_not_initialized') return false;
  if (String(channel?.consumer_reason ?? '').startsWith('unsupported_')) return true;
  return channel?.delivery_ready === true && channel?.consumer_ready !== false;
}
function dedupeWarnings(values) {
  const warnings = new Map();
  for (const value of values.filter(w => w && typeof w.code === 'string')) {
    const key = `${value.code}:${value.provider ?? ''}:${value.pi_version ?? ''}`;
    const previous = warnings.get(key);
    warnings.set(key, { ...previous, ...value, ...((previous?.legacy_metadata || value.legacy_metadata) ? { legacy_metadata: true } : {}) });
  }
  return [...warnings.values()];
}
export function targetCompatibilityWarnings({ fact, target, channel } = {}) {
  const values = [...channelCompatibilityWarnings(channel)];
  for (const source of [fact, target]) {
    const compatibility = source?.compatibility;
    if (!compatibility) continue;
    if (Array.isArray(compatibility.warnings)) values.push(...compatibility.warnings);
    if (!['unsupported', 'unverified'].includes(compatibility.status)) continue;
    const pi = source.harness === 'pi' || compatibility.pi_version != null || compatibility.supported_pi_version != null;
    if (pi) values.push(warning('PI_VERSION_UNVERIFIED', `Compatibility metadata is advisory; Golem is tested on Pi ${SUPPORTED_PI_VERSION}. Normal delivery will be attempted.`, {
      ...(typeof compatibility.pi_version === 'string' ? { pi_version: compatibility.pi_version } : {}),
      supported_pi_version: SUPPORTED_PI_VERSION, legacy_metadata: compatibility.status === 'unsupported',
    }));
    else if (!compatibility.warnings?.length) values.push(warning('RUNTIME_COMPATIBILITY_UNVERIFIED',
      'Runtime compatibility metadata is advisory; actual initialization and delivery results remain authoritative.', { legacy_metadata: compatibility.status === 'unsupported' }));
  }
  return dedupeWarnings(values);
}
