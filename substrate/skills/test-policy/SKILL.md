---
name: test-policy
description: Load when writing tests or scoping checks. Prove behavior and affected consumers through isolated tests and real integration paths, using the project's test system.
---

# Test policy

- Follow the repository's test framework, layout, and runners; no parallel framework.
- Prove observable behavior, failures, and affected consumers. Unit-test isolated logic;
  integrate real storage, services, and harnesses where available. Mocks alone do not prove
  the shipped path.
- Use isolated state/resources, bounded waits, and cleanup. Never mutate live work in tests.
- Assert fixtures exercise the behavior. For critical regressions, show the check fails when
  that behavior is broken. Do not mirror the implementation's call sequence.
- Report commands, outcomes, and checks not run with reasons. A passing subset is not a full
  acceptance pass. Name any necessary manual probe.
- Scratch tickets use the quarantined helper named in project `AGENTS.md`; archive in cleanup.
