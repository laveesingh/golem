import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';

const nullableString = Type.Union([Type.String(), Type.Null()]);
export const JsonValue = Type.Recursive(
  (Self) =>
    Type.Union([
      Type.String(),
      Type.Number(),
      Type.Boolean(),
      Type.Null(),
      Type.Array(Self),
      Type.Record(Type.String(), Self),
    ]),
  { $id: 'JsonValue' },
);
const TicketKind = Type.Union([
  Type.Literal('spec'),
  Type.Literal('task'),
  Type.Literal('doc'),
]);
const TicketState = Type.Union(
  ['todo', 'in_progress', 'blocked', 'review', 'done', 'archived'].map(
    (value) => Type.Literal(value),
  ),
);
export const HealthResponse = Type.Object(
  {
    ok: Type.Literal(true),
    projects_root: Type.String(),
    project_count: Type.Integer(),
    server_time: Type.String(),
  },
  { $id: 'HealthResponse', additionalProperties: true },
);
export const TicketCreateBody = Type.Object(
  {
    project_id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    kind: Type.Optional(
      Type.Union([TicketKind, Type.Null()], { default: 'task' }),
    ),
    body: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { default: '' }),
    ),
    body_format: Type.Optional(
      Type.Union(
        [
          Type.Literal('markdown'),
          Type.Literal('html'),
          Type.Literal(''),
          Type.Null(),
        ],
        { default: 'markdown' },
      ),
    ),
    priority: Type.Optional(nullableString),
    labels: Type.Optional(Type.Array(Type.String(), { default: [] })),
    parent_id: Type.Optional(nullableString),
    assignee: Type.Optional(nullableString),
    created_by: Type.Optional(nullableString),
    source_ref: Type.Optional(nullableString),
  },
  { $id: 'TicketCreateBody', additionalProperties: true },
);
const OutlineBlock = Type.Object(
  {
    id: Type.String(),
    parent_id: nullableString,
    kind: Type.String(),
    tag: Type.String(),
    heading: nullableString,
    short_text: Type.String(),
    hash: Type.String(),
    mermaid_error: Type.Optional(Type.Ref(JsonValue)),
  },
  { additionalProperties: true },
);
export const TicketCreated = Type.Object(
  {
    id: Type.String(),
    seq: Type.Integer(),
    project_id: Type.String(),
    kind: TicketKind,
    title: Type.String(),
    body: Type.String(),
    body_format: Type.Union([Type.Literal('markdown'), Type.Literal('html')]),
    body_revision: Type.Integer(),
    state: TicketState,
    priority: nullableString,
    labels: Type.Array(Type.String()),
    parent_id: nullableString,
    assignee: nullableString,
    created_by: Type.String(),
    dispatched_to: nullableString,
    dispatched_at: nullableString,
    source_ref: nullableString,
    created_at: Type.String(),
    updated_at: Type.String(),
    pseq: Type.Integer(),
    display_id: Type.String(),
    outline: Type.Optional(Type.Array(OutlineBlock)),
    mermaid_errors: Type.Optional(Type.Array(Type.Ref(JsonValue))),
  },
  { $id: 'TicketCreated', additionalProperties: true },
);
export const PilotError = Type.Object(
  {
    error: Type.String(),
    code: Type.Optional(Type.String()),
    statusCode: Type.Optional(Type.Integer()),
    message: Type.Optional(Type.String()),
    block_id: Type.Optional(Type.String()),
  },
  { $id: 'PilotError', additionalProperties: true },
);
export type TicketCreateInput = Static<typeof TicketCreateBody>;
export type TicketCreatedOutput = Static<typeof TicketCreated>;
export const pilotSchemas = {
  HealthResponse,
  TicketCreateBody,
  TicketCreated,
  PilotError,
};
