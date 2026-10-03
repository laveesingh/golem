// Provisional local scenario DTO. W3 may adopt this into canonical contracts;
// this dependency-free module is not a second shared contracts registry.
const BOUNDARIES = ['hook', 'mcp', 'typed-http', 'process', 'herdr'];
export const HARNESSES = ['claudecode', 'pi', 'herdr'];
export const SCENARIOS = [
    'typed-brief-accepted-settled',
    'claude-dispatch-ack-return',
    'herdr-worker-lifecycle',
    'dashboard-restart-stranded-envelope',
];
const OPERATIONS = [
    'hook-input',
    'mcp-call',
    'mcp-return',
    'typed-submit',
    'typed-accepted',
    'typed-settled',
    'process-spawn',
    'process-stdin',
    'process-stdout',
    'process-stderr',
    'process-exit',
    'herdr-command',
    'herdr-result',
];
export class ScenarioError extends Error {
    constructor(message = 'scenario contract rejected') {
        super(message);
        this.name = 'ScenarioError';
    }
}
export function record(value) {
    if (!value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype)
        throw new ScenarioError('expected a plain record');
    return value;
}
export function exactKeys(value, keys) {
    if (Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key)))
        throw new ScenarioError('unknown or missing structural field');
}
export function member(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        throw new ScenarioError('unknown structural enum');
    return value;
}
export function integer(value, max = 1_000_000_000) {
    if (typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > max)
        throw new ScenarioError('invalid bounded integer');
    return value;
}
export function header(value) {
    const input = record(value);
    exactKeys(input, ['schema', 'scenario', 'source', 'seed', 'events']);
    if (input.schema !== 1)
        throw new ScenarioError('unknown scenario schema');
    const name = input.scenario;
    if (typeof name !== 'string' ||
        !SCENARIOS.some((id) => name === id || name === `synthetic-${id}`))
        throw new ScenarioError('unknown scenario identity');
    const source = record(input.source);
    exactKeys(source, ['harness', 'harness_version', 'golem_version']);
    const synthetic = name.startsWith('synthetic-');
    const version = (v) => {
        if (typeof v !== 'string' ||
            (synthetic
                ? v !== 'synthetic'
                : !/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)\.\d{1,4})?$/.test(v)))
            throw new ScenarioError('unpinned or uncertain source version');
        return v;
    };
    if (!Array.isArray(input.events) ||
        !input.events.length ||
        input.events.length > 10_000)
        throw new ScenarioError('invalid bounded event sequence');
    return {
        schema: 1,
        scenario: name,
        source: {
            harness: member(source.harness, HARNESSES),
            harness_version: version(source.harness_version),
            golem_version: version(source.golem_version),
        },
        seed: integer(input.seed, 0xffffffff),
        events: input.events,
    };
}
export function eventEnvelope(value, seq, previousTime) {
    const event = record(value);
    exactKeys(event, [
        'seq',
        'at_ms',
        'boundary',
        'direction',
        'operation',
        'fields',
    ]);
    if (event.seq !== seq)
        throw new ScenarioError('event sequence must be contiguous, starting at 1');
    const at_ms = integer(event.at_ms);
    if (at_ms < previousTime)
        throw new ScenarioError('event time must be monotonic');
    const boundary = member(event.boundary, BOUNDARIES), direction = member(event.direction, ['in', 'out']), operation = member(event.operation, OPERATIONS);
    const expectedBoundary = operation.startsWith('process-')
        ? 'process'
        : operation.startsWith('typed-')
            ? 'typed-http'
            : operation.startsWith('mcp-')
                ? 'mcp'
                : operation.startsWith('herdr-')
                    ? 'herdr'
                    : 'hook';
    const expectedDirection = [
        'hook-input',
        'mcp-call',
        'typed-submit',
        'process-spawn',
        'process-stdin',
        'herdr-command',
    ].includes(operation)
        ? 'in'
        : 'out';
    if (boundary !== expectedBoundary || direction !== expectedDirection)
        throw new ScenarioError('operation boundary/direction mismatch');
    return {
        seq,
        at_ms,
        boundary,
        direction,
        operation,
        fields: record(event.fields),
    };
}
