import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { contractRemovals } from './contract-diff.mjs';

const baseline = JSON.parse(
  fs.readFileSync(
    new URL('../contracts/release-baseline.json', import.meta.url),
    'utf8',
  ),
);
if (baseline.mode === 'initial-6.0-bootstrap') {
  const provenance = JSON.parse(
    fs.readFileSync(
      new URL(
        '../contracts/release-source/5.26.0/provenance.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const bytes = fs.readFileSync(
    new URL('../contracts/release-source/5.26.0/package.json', import.meta.url),
  );
  const prior = JSON.parse(bytes.toString('utf8'));
  if (
    prior.version !== baseline.released_version ||
    provenance.released_source_commit !== baseline.released_source_commit ||
    provenance.capture_exit !== 0 ||
    provenance.schema_paths.length !== 0 ||
    createHash('sha256').update(bytes).digest('hex') !==
      provenance.package_sha256
  )
    throw Error('frozen release-source absence evidence invalid');
  console.log(
    JSON.stringify({
      contract_compatibility: 'UNVERIFIED_INITIAL_BOOTSTRAP',
      released_version: baseline.released_version,
      source: baseline.released_source_commit,
      reason:
        'prior release has no canonical schemas; no released-schema compatibility pass claimed',
      policy:
        '6.0 deliberate breaking wave, then compare actual released artefacts',
    }),
  );
} else {
  if (!baseline.released_schema_path)
    throw Error(
      'released artefact schema path required; no PR self-baseline fallback',
    );
  const before = JSON.parse(
    fs.readFileSync(baseline.released_schema_path, 'utf8'),
  );
  const after = JSON.parse(
    fs.readFileSync(
      new URL('../contracts/dist/openapi.json', import.meta.url),
      'utf8',
    ),
  );
  const removed = contractRemovals(before, after);
  if (removed.length)
    throw Error(
      `contract removals require versioned/deprecation evidence: ${removed.join(', ')}`,
    );
  console.log('released artefact contract diff: pass');
}
