// Local animated agent icons (idle at rest, active while working). Copied from the
// icon studio into assets/agent-icons/. tencent has no animated variant yet, so it
// keeps the static lobehub icon as the lone exception.
import anthropicIdle from './assets/agent-icons/providers/anthropic-idle.svg?url';
import anthropicActive from './assets/agent-icons/providers/anthropic-active.svg?url';
import deepSeekIdle from './assets/agent-icons/providers/deepseek-idle.svg?url';
import deepSeekActive from './assets/agent-icons/providers/deepseek-active.svg?url';
import geminiIdle from './assets/agent-icons/providers/gemini-idle.svg?url';
import geminiActive from './assets/agent-icons/providers/gemini-active.svg?url';
import gemmaIdle from './assets/agent-icons/providers/gemma-idle.svg?url';
import gemmaActive from './assets/agent-icons/providers/gemma-active.svg?url';
import grokIdle from './assets/agent-icons/providers/grok-idle.svg?url';
import grokActive from './assets/agent-icons/providers/grok-active.svg?url';
import minimaxIdle from './assets/agent-icons/providers/minimax-idle.svg?url';
import minimaxActive from './assets/agent-icons/providers/minimax-active.svg?url';
import ollamaIdle from './assets/agent-icons/providers/ollama-idle.svg?url';
import ollamaActive from './assets/agent-icons/providers/ollama-active.svg?url';
import openAiIdle from './assets/agent-icons/providers/openai-idle.svg?url';
import openAiActive from './assets/agent-icons/providers/openai-active.svg?url';
import astraIdle from './assets/agent-icons/models/gpt-6-astra-idle.svg?url';
import astraActive from './assets/agent-icons/models/gpt-6-astra-active.svg?url';
import qwenIdle from './assets/agent-icons/providers/qwen-idle.svg?url';
import qwenActive from './assets/agent-icons/providers/qwen-active.svg?url';
import zaiIdle from './assets/agent-icons/providers/zai-idle.svg?url';
import zaiActive from './assets/agent-icons/providers/zai-active.svg?url';
import metaIdle from './assets/agent-icons/providers/meta-idle.svg?url';
import metaActive from './assets/agent-icons/providers/meta-active.svg?url';
import claudeCodeIdle from './assets/agent-icons/harnesses/claudecode-idle.svg?url';
import claudeCodeActive from './assets/agent-icons/harnesses/claudecode-active.svg?url';
import piIdle from './assets/agent-icons/harnesses/pi-idle.svg?url';
import piActive from './assets/agent-icons/harnesses/pi-active.svg?url';
import tencentIcon from '@lobehub/icons-static-svg/icons/tencent-color.svg?url';
import {
  FALLBACK,
  PROVIDER_MATCHERS,
  providerForId as matchProviderForId,
  providerForModel as matchProviderForModel,
  resolveProvider as matchResolveProvider,
} from './model-provider-match.mjs';

(function () {
  // Each provider/harness carries an idle icon (at rest) and an active icon
  // (animated while the agent works). tencent has only the static lobehub icon,
  // so both states point at it.
  const idleIcons = {
    ollama: ollamaIdle,
    openai: openAiIdle,
    anthropic: anthropicIdle,
    minimax: minimaxIdle,
    'z-ai': zaiIdle,
    deepseek: deepSeekIdle,
    gemma: gemmaIdle,
    google: geminiIdle,
    tencent: tencentIcon,
    grok: grokIdle,
    qwen: qwenIdle,
    meta: metaIdle,
  };
  const activeIcons = {
    ollama: ollamaActive,
    openai: openAiActive,
    anthropic: anthropicActive,
    minimax: minimaxActive,
    'z-ai': zaiActive,
    deepseek: deepSeekActive,
    gemma: gemmaActive,
    google: geminiActive,
    tencent: tencentIcon,
    grok: grokActive,
    qwen: qwenActive,
    meta: metaActive,
  };

  function iconsFor(id, model) {
    // This identity belongs to the exact model, not the GPT family or provider.
    // Keep the provider metadata (OpenAI) and every other model's icons intact.
    const isAstra = model === 'gpt-6-astra';
    const idleSrc = isAstra ? astraIdle : (idleIcons[id] || null);
    const activeSrc = isAstra ? astraActive : (activeIcons[id] || null);
    // iconSrc stays as the idle URL for back-compat with any older consumer.
    return {
      iconSrc: idleSrc, iconIdleSrc: idleSrc, iconActiveSrc: activeSrc,
      // Embedded SVG media queries are not honored consistently by browsers.
      ...(isAstra ? { iconReducedMotionSrc: idleSrc } : {}),
    };
  }

  const providers = PROVIDER_MATCHERS.map((entry) => ({
    ...entry,
    ...iconsFor(entry.id),
  }));
  const fallback = { ...FALLBACK, iconSrc: null, iconIdleSrc: null, iconActiveSrc: null };
  const harnesses = {
    claudecode: { id: 'claudecode', label: 'Claude Code', iconIdleSrc: claudeCodeIdle, iconActiveSrc: claudeCodeActive, iconSrc: claudeCodeIdle },
    pi: { id: 'pi', label: 'Pi', iconIdleSrc: piIdle, iconActiveSrc: piActive, iconSrc: piIdle },
  };

  function withIcon(entry, model) {
    if (!entry) return entry;
    if (entry.id === 'fallback') return fallback;
    return { ...entry, ...iconsFor(entry.id, model) };
  }

  function providerForId(provider) {
    return withIcon(matchProviderForId(provider));
  }

  function providerForModel(model) {
    return withIcon(matchProviderForModel(model), model);
  }

  function resolveProvider(provider, model) {
    return withIcon(matchResolveProvider(provider, model), model);
  }

  function harnessForId(harness) {
    return harnesses[harness] || null;
  }

  window.ModelProviders = {
    providers,
    fallback,
    providerForId,
    providerForModel,
    resolveProvider,
    harnesses,
    harnessForId,
  };
})();
