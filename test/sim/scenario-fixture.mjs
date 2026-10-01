// Authored synthetic test data only. Never a recording/golden provenance claim.
export function scenario(events, seed = 7) {
  return {
    schema: 1,
    scenario: 'synthetic-herdr-worker-lifecycle',
    source: {
      harness: 'herdr',
      harness_version: 'synthetic',
      golem_version: 'synthetic',
    },
    seed,
    events: events.map((event, index) => ({
      ...event,
      seq: index + 1,
      at_ms: index,
    })),
  };
}
export function processTransaction(
  harness,
  argv,
  {
    result = { ok: true },
    exitCode = 0,
    signal,
    stdin,
    stderr,
    recipe = 'json',
  } = {},
) {
  const event = (operation, direction, fields) => ({
    boundary: 'process',
    operation,
    direction,
    fields: { harness, ...fields },
  });
  return [
    event('process-spawn', 'in', { argv }),
    ...(stdin
      ? [event('process-stdin', 'in', { stdin: '<redacted:stdin>' })]
      : []),
    ...(stderr
      ? [event('process-stderr', 'out', { stderr: '<redacted:stderr>' })]
      : []),
    event('process-stdout', 'out', {
      stdout_recipe: recipe,
      ...(recipe === 'json' ? { result } : {}),
    }),
    event('process-exit', 'out', signal ? { signal } : { exit_code: exitCode }),
  ];
}
export function typedCandidate() {
  return {
    schema: 1,
    scenario: 'synthetic-typed-brief-accepted-settled',
    source: {
      harness: 'pi',
      harness_version: 'synthetic',
      golem_version: 'synthetic',
    },
    seed: 7,
    events: [
      {
        seq: 1,
        at_ms: 0,
        boundary: 'typed-http',
        direction: 'in',
        operation: 'typed-submit',
        fields: {
          envelope_id: 'private-fixture-envelope',
          attempt_id: 'private-fixture-attempt',
          session_id: 'private-fixture-session',
          path: '/Users/synthetic-person/private',
          pid: 42424,
          port: 12345,
          content: 'synthetic prompt secret',
          body: 'synthetic body',
          tool_output: { raw: 'synthetic file contents' },
          env: { TOKEN: 'synthetic-token' },
          credentials: 'synthetic-credential',
          username: 'synthetic-person',
        },
      },
      {
        seq: 2,
        at_ms: 1,
        boundary: 'typed-http',
        direction: 'out',
        operation: 'typed-accepted',
        fields: {
          envelope_id: 'private-fixture-envelope',
          accepted: true,
          state: 'accepted',
        },
      },
    ],
  };
}
