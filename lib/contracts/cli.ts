import type { TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import { JsonValue } from './pilot.ts';

const json = Type.Ref(JsonValue);
const help = { help: Type.String() };
const plan = {
  dry_run: Type.Literal(true),
  operation: Type.String(),
  plan: json,
  resolution: json,
};
const error = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
  details: Type.Optional(json),
});
function result(
  id: string,
  variants: Record<string, TSchema>[],
  versions = [1],
) {
  const version = Type.Union(versions.map((value) => Type.Literal(value)));
  return Type.Union(
    [
      ...variants.map((fields) =>
        Type.Object(
          { schema_version: version, ok: Type.Literal(true), ...fields },
          { additionalProperties: true },
        ),
      ),
      Type.Object(
        { schema_version: version, ok: Type.Literal(false), error },
        { additionalProperties: true },
      ),
    ],
    { $id: id },
  );
}
const list = { items: Type.Array(json), resolution: json };
export const CliAgentResult = result(
  'CliAgentResult',
  [
    help,
    plan,
    list,
    { items: Type.Array(Type.String()) },
    { session_id: Type.String() },
    { text: Type.String() },
    { roles: Type.Array(json) },
    { kind: Type.String(), id: Type.String(), state: Type.String() },
  ],
  [1, 2],
);
export const CliSessionResult = result(
  'CliSessionResult',
  [help, plan, list, { session: Type.String() }],
  [1, 2],
);
export const CliTeamResult = result(
  'CliTeamResult',
  [help, plan, list, { team_id: Type.String() }],
  [1, 2],
);
export const CliContextResult = result('CliContextResult', [
  help,
  { resolution: json },
]);
export const CliScheduleResult = result('CliScheduleResult', [
  help,
  { items: Type.Array(json) },
  { kind: Type.Literal('schedule'), id: Type.String(), state: Type.String() },
]);
export const CliMessageResult = result('CliMessageResult', [
  help,
  { kind: Type.Literal('message'), id: Type.String(), state: Type.String() },
]);
export const CliTicketResult = result('CliTicketResult', [
  help,
  { items: Type.Array(json) },
  { id: Type.String() },
  { body_revision: Type.Integer() },
  { ticket_id: Type.String() },
  { block_id: Type.String() },
  { kind: Type.String(), source: Type.String() },
]);
export const CliStatusResult = result('CliStatusResult', [
  help,
  {
    dashboard_url: Type.Union([Type.String(), Type.Null()]),
    dashboard_healthy: Type.Boolean(),
    dashboard: json,
  },
]);
export const cliSchemas = {
  CliAgentResult,
  CliSessionResult,
  CliTeamResult,
  CliContextResult,
  CliScheduleResult,
  CliMessageResult,
  CliTicketResult,
  CliStatusResult,
};
