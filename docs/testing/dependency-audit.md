# W2 dependency audit snapshot

Commands on 2026-10-01:
- Baseline20a5cf5 root `npm audit --package-lock-only --json > /tmp/gol458-audit-baseline.json`: exit1, 10 findings (8high/1moderate/1low).
- W2 `npm audit --json > /tmp/gol458-audit-new.json`: exit1, nine findings (7high/1moderate/1low).
- W2 `npm ls @fastify/static brace-expansion dompurify fast-uri fastify find-my-way js-yaml nanoid postcss --all`: exit0, source for chains below.

All nine remaining affected packages/versions already exist in the baseline lock. No new vulnerable package is attributed to W2's tooling installation by this audit snapshot. Vite6.3.5's baseline high finding disappears after compatible root lock resolution to6.4.3; no broad audit-fix was run. This does **not** establish that other versions/path usages are safe.

| Package / locked version | Severity | Root direct? | Runtime/dependency chain and exposure boundary |
| --- | --- | --- | --- |
| @fastify/static7.0.4 | high | yes | Production dashboard static route registration. Advisory route-guard/path-traversal conditions require runtime/security review; not proven absent. |
| brace-expansion2.1.1 | high | no | @fastify/static→glob→minimatch. Production dependency tree; input reachability of vulnerable expansion patterns not established. |
| dompurify3.4.13 | low | yes | Dashboard rich-content sanitization and mermaid dependency. Advisory requires particular IN_PLACE/hook behavior; no claim that all usage is unaffected. |
| fast-uri2.4.0 and3.1.3 | high | no | Fastify→ajv-compiler/fast-json-stringify; Ajv also carries3.1.3. Production URI/schema normalization tree. Host-confusion/path/SSRF advisory preconditions need ingress review. |
| fastify4.29.1 | high | yes | Production API server. Multiple body/schema/header/HTTP2 advisory conditions plus find-my-way; exposure not evaluated by runner migration. |
| find-my-way8.2.2 | high | no | Fastify router; HTTP2 DoS advisory. Production dependency, not ruled harmless. |
| js-yaml3.15.0 | high | no | gray-matter frontmatter parsing in production substrate/model metadata. Quadratic/merge parser conditions need input trust/size review. No instruction audit is added here. |
| nanoid3.3.16 | high | no | Vite→PostCSS build/dev toolchain. Custom-generator zero-size loop advisory; production shipping/server execution is not established, dev/build exposure remains. |
| postcss8.5.18 | moderate | no | Vite build/dev CSS pipeline. Advisory sourceMappingURL/read conditions need build-input review; not a new W2 runtime dependency. |

Root Vite was already a devDependency; the new Vitest runner also uses compatible Vite. New TS/Biome/Knip/jsdom/Testing Library/Playwright dependencies are exact-pinned devDependencies and have no additional package finding in this snapshot. Audit outputs are snapshots, not a security certification; reevaluate on dependency changes.

No unrelated remediation or runtime behavior change is included in W2. Existing runtime vulnerability remediation remains a separately scoped decision. W3 tarball/W7 render checks must exercise actual shipped dependency graphs; this root audit does not replace those artefact checks.
