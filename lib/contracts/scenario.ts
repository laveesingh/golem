import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';

export const ScenarioSource = Type.Object(
  {
    harness: Type.Union([
      Type.Literal('claudecode'),
      Type.Literal('pi'),
      Type.Literal('herdr'),
    ]),
    harness_version: Type.String({ minLength: 1 }),
    golem_version: Type.String({ minLength: 1 }),
  },
  { $id: 'ScenarioSource', additionalProperties: false },
);
export const ScenarioEvent = Type.Object(
  {
    seq: Type.Integer({ minimum: 1 }),
    at_ms: Type.Integer({ minimum: 0 }),
    boundary: Type.Union([
      Type.Literal('hook'),
      Type.Literal('mcp'),
      Type.Literal('typed-http'),
      Type.Literal('process'),
      Type.Literal('herdr'),
    ]),
    direction: Type.Union([Type.Literal('in'), Type.Literal('out')]),
    operation: Type.Union([
      Type.Literal('hook-input'),
      Type.Literal('mcp-call'),
      Type.Literal('mcp-return'),
      Type.Literal('typed-submit'),
      Type.Literal('typed-accepted'),
      Type.Literal('typed-settled'),
      Type.Literal('process-spawn'),
      Type.Literal('process-stdin'),
      Type.Literal('process-stdout'),
      Type.Literal('process-stderr'),
      Type.Literal('process-exit'),
      Type.Literal('herdr-command'),
      Type.Literal('herdr-result'),
    ]),
    fields: Type.Record(Type.String(), Type.Any()),
  },
  { $id: 'ScenarioEvent', additionalProperties: false },
);
export const ScenarioFixture = Type.Object(
  {
    schema: Type.Literal(1),
    scenario: Type.Union([
      Type.Literal('typed-brief-accepted-settled'),
      Type.Literal('claude-dispatch-ack-return'),
      Type.Literal('herdr-worker-lifecycle'),
      Type.Literal('dashboard-restart-stranded-envelope'),
    ]),
    source: ScenarioSource,
    seed: Type.Integer({ minimum: 0 }),
    events: Type.Array(ScenarioEvent, { minItems: 1 }),
  },
  { $id: 'ScenarioFixture', additionalProperties: false },
);
export type ScenarioSourceInput = Static<typeof ScenarioSource>;
export type ScenarioEventInput = Static<typeof ScenarioEvent>;
export type ScenarioFixtureInput = Static<typeof ScenarioFixture>;
export const scenarioSchemas = {
  ScenarioSource,
  ScenarioEvent,
  ScenarioFixture,
};
