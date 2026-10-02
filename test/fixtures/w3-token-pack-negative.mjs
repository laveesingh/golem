import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox } from '../support/sandbox.mjs';

// The caller provides an OWNED archive of actual Golem source, already built
// and packed once. Never mutate a real checkout or use a substitute package.
const source = fs.realpathSync(process.argv[2]);
const tarball = fs.realpathSync(process.argv[3]);
const npmCli = fs.realpathSync(process.argv[4]);
assert.equal(
  JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).name,
  '@laveesingh/golem',
);
const sandbox = createSandbox();
const pointer = path.join(source, 'dashboard/web/src/ui/tokens/generated');
const originalPointer = fs.readlinkSync(pointer);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (dir) => {
  const values = {};
  const walk = (root) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      assert.ok(!entry.isSymbolicLink(), file);
      if (entry.isDirectory()) walk(file);
      else values[path.relative(dir, file)] = sha(fs.readFileSync(file));
    }
  };
  walk(dir);
  return values;
};
const runPack = (extra = {}) => {
  const result = spawnSync(
    process.execPath,
    [npmCli, 'pack', '--pack-destination', path.dirname(tarball)],
    {
      cwd: source,
      env: { ...sandbox.env, ...extra },
      encoding: 'utf8',
      timeout: 120000,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  return result;
};
try {
  const beforeDist = digest(path.join(source, 'dist'));
  const beforeWeb = digest(path.join(source, 'dashboard/dist'));
  const beforeTarball = sha(fs.readFileSync(tarball));
  for (const [relative, mode] of [
    ['dashboard/web/src/ui/tokens/generated/tokens.css', 'tamper'],
    ['dashboard/web/src/ui/fonts/geist-latin-400-normal.woff2', 'tamper'],
    ['dashboard/web/src/ui/tokens/source/primitive.tokens.json', 'missing'],
    ['dashboard/web/src/ui/tokens/entry.css', 'escape'],
  ]) {
    const file = path.join(source, relative),
      bytes = fs.readFileSync(file);
    try {
      if (mode === 'missing') fs.unlinkSync(file);
      else if (mode === 'escape')
        fs.writeFileSync(file, '@import "../../../../outside.css";');
      else fs.appendFileSync(file, 'tamper');
      const result = runPack();
      assert.notEqual(
        result.status,
        0,
        `${mode} must fail actual Golem prepack`,
      );
      assert.deepEqual(digest(path.join(source, 'dist')), beforeDist);
      assert.deepEqual(digest(path.join(source, 'dashboard/dist')), beforeWeb);
      assert.equal(sha(fs.readFileSync(tarball)), beforeTarball);
      assert.equal(
        fs.existsSync(path.join(source, '.golem-package.lock')),
        false,
      );
      assert.equal(
        fs
          .readdirSync(source)
          .some((name) => name.startsWith('.golem-package-stage-')),
        false,
      );
    } finally {
      fs.writeFileSync(file, bytes);
    }
  }
  const hook = path.join(sandbox.root, 'pointer-change.mjs');
  const log = path.join(sandbox.root, 'pointer-reads.json');
  const alternate = `.generations/g-${'a'.repeat(64)}`;
  fs.writeFileSync(
    hook,
    `
import fs from 'node:fs';
if (process.argv[1]?.endsWith('/tools/package-build.mjs')) {
 const original=fs.readlinkSync; let reads=0;
 fs.readlinkSync=function(file,...args) {
  const value=original.call(this,file,...args);
  if (String(file)===${JSON.stringify(pointer)}) {
   reads++; fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({reads}));
   if(reads===1) { fs.unlinkSync(file); fs.symlinkSync(${JSON.stringify(alternate)},file); }
  }
  return value;
 };
}
`,
  );
  try {
    const result = runPack({
      NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --import=${hook}`,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(log)).reads, 1);
    assert.equal(
      fs.readlinkSync(pointer),
      alternate,
      'producer must not overwrite injected pointer change',
    );
    assert.equal(
      fs
        .readFileSync(
          path.join(
            source,
            'dist/assets/dashboard/web/src/ui/tokens/token-package.json',
          ),
          'utf8',
        )
        .includes(originalPointer.split('/')[1]),
      true,
    );
    assert.deepEqual(
      digest(
        path.join(source, 'dist/assets/dashboard/web/src/ui/tokens/generated'),
      ),
      Object.fromEntries(
        ['tokens.css', 'tokens.ts', 'contrast.json', 'registry.json'].map(
          (file) => [
            file,
            sha(
              fs.readFileSync(
                path.join(
                  source,
                  'dashboard/web/src/ui/tokens',
                  originalPointer,
                  file,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  } finally {
    if (fs.readlinkSync(pointer) === alternate) {
      fs.unlinkSync(pointer);
      fs.symlinkSync(originalPointer, pointer);
    }
  }
  assert.equal(fs.readlinkSync(pointer), originalPointer);
  // Real compiler outputs, then private namespace replacement before the
  // publisher resumes. Replacement identities are logged by this owned hook.
  for (const kind of ['lock', 'stage']) {
    const faultHook = path.join(sandbox.root, `replace-${kind}.mjs`);
    const faultLog = path.join(sandbox.root, `replace-${kind}.json`);
    const held = path.join(source, `fixture-held-${kind}`);
    const stableRuntime = digest(path.join(source, 'dist'));
    const stableWeb = digest(path.join(source, 'dashboard/dist'));
    const stableTar = sha(fs.readFileSync(tarball));
    fs.writeFileSync(
      faultHook,
      `
import fs from 'node:fs'; import path from 'node:path'; import cp from 'node:child_process';
if(process.argv[1]?.endsWith('/tools/package-build.mjs')) {
 const original=cp.spawnSync;
 cp.spawnSync=function(command,args,options) {
  const result=original.call(this,command,args,options);
  const i=args.indexOf('--outDir');
  if(i>=0 && path.basename(args[i+1])==='web' && result.status===0) {
   const stage=path.dirname(args[i+1]),lock=${JSON.stringify(path.join(source, '.golem-package.lock'))};
   if(${JSON.stringify(kind)}==='lock') { fs.renameSync(lock,${JSON.stringify(held)});fs.writeFileSync(lock,'replacement-lock',{flag:'wx',mode:0o600}); }
   else { fs.renameSync(stage,${JSON.stringify(held)});fs.cpSync(${JSON.stringify(held)},stage,{recursive:true});fs.writeFileSync(path.join(stage,'replacement-sentinel'),'untouched'); }
   const rows=[stage,lock,${JSON.stringify(held)}].map(file=>{const s=fs.lstatSync(file);return {file,ino:s.ino,dev:s.dev,directory:s.isDirectory()};});
   fs.writeFileSync(${JSON.stringify(faultLog)},JSON.stringify(rows));
  }
  return result;
 };
}
`,
    );
    try {
      const result = runPack({
        NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --import=${faultHook}`,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /identity changed/);
      assert.deepEqual(
        digest(path.join(source, 'dist')),
        stableRuntime,
        `${kind} must refuse before runtime publication`,
      );
      assert.deepEqual(
        digest(path.join(source, 'dashboard/dist')),
        stableWeb,
        `${kind} must refuse before web publication`,
      );
      assert.equal(sha(fs.readFileSync(tarball)), stableTar);
      const rows = JSON.parse(fs.readFileSync(faultLog));
      if (kind === 'lock')
        assert.equal(
          fs.readFileSync(path.join(source, '.golem-package.lock'), 'utf8'),
          'replacement-lock',
        );
      else
        assert.equal(
          fs.readFileSync(
            path.join(rows[0].file, 'replacement-sentinel'),
            'utf8',
          ),
          'untouched',
        );
    } finally {
      if (fs.existsSync(faultLog)) {
        const rows = JSON.parse(fs.readFileSync(faultLog));
        for (const row of rows) {
          const current = fs.lstatSync(row.file);
          assert.equal(current.ino, row.ino);
          assert.equal(current.dev, row.dev);
          assert.ok(!current.isSymbolicLink());
        }
        // Exact hook-allocated retained fixtures only, never borrowed recovery
        // authority in production or a guessed replacement directory deletion.
        for (const row of rows) {
          if (row.directory) fs.rmSync(row.file, { recursive: true });
          else fs.unlinkSync(row.file);
        }
      }
    }
  }
  console.log(
    'ACTUAL GOLEM PREPACK FAILURES PASS: tampered/missing/escaping inputs preserve prior runtime/web/tarball; one source pointer capture despite pointer replacement; prepublication lock/stage replacements preserve prior outputs; owned fixture restored',
  );
} finally {
  sandbox.cleanup();
}
