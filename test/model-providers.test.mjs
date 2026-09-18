import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import {
  providerForId,
  providerForModel,
  resolveProvider,
} from '../dashboard/web/src/model-provider-match.mjs';

test('harness-adjacent provider ids alias onto the family icon', () => {
  assert.equal(providerForId('openai-codex')?.id, 'openai');
  assert.equal(providerForId('xai')?.id, 'grok');
  assert.equal(providerForId('ollama-cloud')?.id, 'ollama');
  assert.equal(providerForId('unknown-host'), null);
});

test('model ids used under Pi resolve to the family icon', () => {
  assert.equal(providerForModel('gpt-5.6-luna').id, 'openai');
  assert.equal(providerForModel('grok-4.6').id, 'grok');
  assert.equal(providerForModel('deepseek-v4-flash:0731-cloud').id, 'deepseek');
  assert.equal(providerForModel('gemma4:26b-mlx').id, 'gemma');
  assert.equal(providerForModel('qwen3.6:27b-mlx').id, 'qwen');
});

test('unknown transport ids do not hide a known model family', () => {
  assert.equal(resolveProvider('openai-codex', 'gpt-5.6-luna').id, 'openai');
  assert.equal(resolveProvider('xai', 'grok-4.6').id, 'grok');
  assert.equal(resolveProvider('ollama', 'deepseek-v4-flash:0731-cloud').id, 'deepseek');
  assert.equal(resolveProvider('ollama', 'qwen3.6:27b-mlx').id, 'qwen');
  assert.equal(resolveProvider('ollama', 'gemma4:12b-mlx').id, 'gemma');
  assert.equal(resolveProvider('omlx', 'Muse-Glimmer-30B-4bit').id, 'fallback');
});

test('the browser asset resolver gives only exact gpt-6-astra the approved B/B.02 pair', async () => {
  // Exercise the real browser adapter and Vite's SVG URL loading, not a second
  // implementation of the matching rule. Build in memory; no server or dist writes.
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../dashboard/web/src/model-providers.js', import.meta.url)),
        name: 'ModelProvidersTest',
        formats: ['iife'],
      },
    },
  });
  const window = {};
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  runInNewContext(output.find((entry) => entry.type === 'chunk').code, { window });
  const api = window.ModelProviders;
  const family = api.providerForId('openai');
  const astra = api.providerForModel('gpt-6-astra');
  assert.equal(astra.id, 'openai');
  assert.equal(astra.label, 'OpenAI');
  assert.equal(astra.iconSrc, astra.iconIdleSrc);
  assert.notEqual(astra.iconIdleSrc, family.iconIdleSrc);
  assert.notEqual(astra.iconActiveSrc, family.iconActiveSrc);
  assert.notEqual(astra.iconActiveSrc, astra.iconIdleSrc);
  assert.equal(astra.iconReducedMotionSrc, astra.iconIdleSrc);
  assert.equal(family.iconReducedMotionSrc, undefined);

  const idleSvg = decodeURIComponent(astra.iconIdleSrc);
  const activeSvg = decodeURIComponent(astra.iconActiveSrc);
  assert.match(idleSvg, /Orbital lens/);
  assert.doesNotMatch(idleSvg, /@keyframes/);
  assert.match(activeSvg, /Lens breathing/);
  assert.match(activeSvg, /2\.8s/);
  assert.match(activeSvg, /prefers-reduced-motion/);

  for (const transport of ['openai', 'openai-codex', 'ollama', 'unknown-host', null]) {
    const resolved = api.resolveProvider(transport, 'gpt-6-astra');
    assert.equal(resolved.id, 'openai');
    assert.equal(resolved.iconIdleSrc, astra.iconIdleSrc);
    assert.equal(resolved.iconActiveSrc, astra.iconActiveSrc);
  }
  for (const model of [
    'gpt-6', 'gpt-5.6-luna', 'gpt-6-astra-preview', 'gpt-6-astra:latest',
    'GPT-6-ASTRA', ' gpt-6-astra ', 'openai/gpt-6-astra', '', null,
  ]) {
    const resolved = api.resolveProvider('openai-codex', model);
    assert.equal(resolved.iconIdleSrc, family.iconIdleSrc, String(model));
    assert.equal(resolved.iconActiveSrc, family.iconActiveSrc, String(model));
  }
  assert.equal(api.providerForId('openai-codex').iconIdleSrc, family.iconIdleSrc);
  assert.equal(api.providers.find((entry) => entry.id === 'openai').iconActiveSrc, family.iconActiveSrc);
  assert.equal(api.providerForModel('claude-fable-5').iconIdleSrc, api.providerForId('anthropic').iconIdleSrc);
  assert.equal(api.providerForModel('not-a-model').iconSrc, null);
});
