import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isCatalogCacheExpired,
  parsePiModelCatalog,
} from '../../dashboard/server/model-catalog.js';

const TABLE = `provider      model                     context  max-out  thinking  images
antigravity   claude-opus-4-6           250K     64K      yes       yes
ollama        gemma4:26b                128K     16.4K    yes       no
ollama-cloud  deepseek-v4-flash:0731    1.0M     65.5K    yes       no
omlx          Qwen3.8-27B-4bit          131.1K   8.2K     yes       yes
openai-codex  gpt-5.6-luna              550K     128K     yes       yes
`;

test('Pi catalog parser uses fixed header offsets and preserves provider/model pairs', () => {
  assert.deepEqual(parsePiModelCatalog(TABLE), {
    providers: [
      'antigravity',
      'ollama',
      'ollama-cloud',
      'omlx',
      'openai-codex',
    ],
    modelsByProvider: {
      antigravity: ['claude-opus-4-6'],
      ollama: ['gemma4:26b'],
      'ollama-cloud': ['deepseek-v4-flash:0731'],
      omlx: ['Qwen3.8-27B-4bit'],
      'openai-codex': ['gpt-5.6-luna'],
    },
  });
});

test('Pi catalog parser rejects output without the fixed-width header', () => {
  assert.throws(
    () => parsePiModelCatalog('provider model\nollama gemma4'),
    /header not found/,
  );
});

test('Pi catalog parser deduplicates repeated rows', () => {
  const repeated = `${TABLE}ollama        gemma4:26b                128K     16.4K    yes       no\n`;
  assert.deepEqual(parsePiModelCatalog(repeated).modelsByProvider.ollama, [
    'gemma4:26b',
  ]);
});

test('Pi catalog parser handles opencode-go provider rows', () => {
  const table = `${TABLE}opencode-go   deepseek-v4-flash         1M       384K     yes       no\n`;
  const result = parsePiModelCatalog(table);
  assert.ok(result.providers.includes('opencode-go'));
  assert.deepEqual(result.modelsByProvider['opencode-go'], [
    'deepseek-v4-flash',
  ]);
});

test('isCatalogCacheExpired respects TTL and handles missing/malformed stamps', () => {
  const now = 1_000_000;
  const ttl = 60_000;
  assert.equal(isCatalogCacheExpired(null, now, ttl), true);
  assert.equal(isCatalogCacheExpired({}, now, ttl), true);
  assert.equal(
    isCatalogCacheExpired({ fetched_at: 'invalid' }, now, ttl),
    true,
  );
  assert.equal(
    isCatalogCacheExpired(
      { fetched_at: new Date(now - 30_000).toISOString() },
      now,
      ttl,
    ),
    false,
  );
  assert.equal(
    isCatalogCacheExpired(
      { fetched_at: new Date(now - 61_000).toISOString() },
      now,
      ttl,
    ),
    true,
  );
});
