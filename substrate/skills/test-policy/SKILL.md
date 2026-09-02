---
name: test-policy
description: Load when you write tests, tell a builder how to test, or scope a check budget. Journey-level proof through real layers, inside the repo's existing test system.
---

# Test policy

- Follow the repository's test system: framework, layout, naming, runners. This governs the
  tests you add.
- Prove observable behavior through the layers that make it real: route plus validation plus
  persistence, against real databases and harnesses where the repo supports it.
- The smallest set that covers the changed behavior and its consumers. A unit test only where
  isolated logic is the clearest proof.
- A test that asserts the code's own call sequence tests structure, not behavior. Delete it.
- What cannot be covered mechanically: say so and name the manual step. No hollow tests.
- Scratch and smoke tickets never go on a real board. Use the quarantined path the repo's
  `AGENTS.md` names; archive fixtures in a `finally` block.
