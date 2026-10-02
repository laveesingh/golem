# W3 contract inventory — implemented shapes before proposed nouns

Pilot sources: lib/contracts/pilot.ts (TypeBox0.33.22, only TypeBox dependency), real Fastify index + typed contract-pilot/policy. BEFORE private route snapshot: test/fixtures/contracts/pilot-before.json, captured at a82ad10 before schema conversion; never overwritten after conversion.

## Implemented pilot

- Health: ok/projects_root/project_count/server_time. Existing fields are required and emitted.
- Ticket creation: actual tracker.createTicket row fields and HTML outline/mermaid extensions; explicit nullable priority/parent/assignee/dispatch/source refs. Body types are validated without coercion; defaults stay in existing handler.
- Legacy semantic and parser errors retain their old top-level error/code/statusCode/message/block_id fields. Unknown requests pass through validation; no removeAdditional or default injection.
- Intentional accepted hardening: numeric title/project_id formerly returned201; now400/invalid_input under locked string/body-no-coercion policy. Other declared body field types follow the same explicit input policy. It is not called an unchanged conversion.
- Swagger registered before all routes; OpenAPI exports from actual private registered schemas without a new public HTTP route. Swagger8 recursive additionalProperties definitions refs are normalized only to existing components, otherwise fail closed.
- Generated web client types cover only the two converted pilots. Other legacy routes remain untyped and are not certified by default Swagger response descriptions.

## Pending noun definitions, not fake schemas

| Noun | Current source / remaining work |
| --- | --- |
| Spec/Task/Doc | Actual tracker kind variants/current ticket fields; pilot created-row contract first, full entity projection still to map |
| Workspace | Current project registry/API projection; label-only mapping, no new multi-root entity |
| Agent/Session/Team | Current management roster/session facts/canonical team sources; projection mapping pending, no persistent-agent redesign |
| Profile | Execution model profile from model-profiles, separate from W1 instance-profile manifest; mapping pending |
| Role | Current role DTO/profile pointers; metadata contract only, no instruction-content audit |
| Milestone | Current milestones projection t/text/session_id; mapping pending |
| InboxItem | Coordinator confirms unified DTO pending GOL431D06; retain provenance-specific envelope/gate/review projection contracts only where actual consumers justify them; no storage/API consolidation or empty/Any canonical DTO |
| StatusLine | Today none, GOL431D07 open; explicit pending-schema entry |
| You | Today none, GOL431D09 open; explicit pending-schema entry |

Coordinator choice: do not export empty/Any schemas for undecided nouns, do not invent storage/product surfaces. Full all-noun acceptance remains pending product decisions; implemented shapes proceed. No blanket entity-any placeholder.

## Remaining W3 gates

Shared Node client typing, complete implemented noun inventory, versioned config/dashboard/share and journal/spool headers, readVersioned consumers/failure tests, packageRoot/marker/asset consumers, JS launcher/prepack emission, installed tarball + clean link smokes, released-artefact contract diff baseline, full affected layers and supported-init Linux are not yet complete. W7 full bundling/render/W8 CLI/W6 scrub stay separate. This pilot is not a full W3 acceptance or release.
