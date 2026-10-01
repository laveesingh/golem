import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
export function runtimeSource(root: string, relative: string): string {
  const candidates = [
    path.join(root, relative),
    path.join(root, 'dist', relative.replace(/\.ts$/, '.js')),
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw Error(`runtime source missing: ${relative}`);
  return file;
}
export function emittedRuntimeSource(file: string): string {
  const source = fs.readFileSync(file, 'utf8');
  // Installed layouts already contain emitted JS. Only source-checkout sync
  // needs the development compiler, never a copied render helper.
  if (
    !file.endsWith('.ts') &&
    !/(?:from\s*|import\s*\()\s*['"][^'"]+\.ts['"]/.test(source)
  )
    return source;
  const ts = require('typescript') as typeof import('typescript');
  const result = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      rewriteRelativeImportExtensions: true,
      allowJs: true,
    },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length)
    throw Error(
      `runtime emit failed: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`,
    );
  return result.outputText;
}
