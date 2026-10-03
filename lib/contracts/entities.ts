import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import { JsonValue, TicketCreated } from './pilot.ts';

const text = Type.String();
const nullableText = Type.Union([text, Type.Null()]);
const extension = { additionalProperties: Type.Ref(JsonValue) };
export const Workspace = Type.Object(
  {
    project_id: text,
    root: text,
    name: Type.Optional(text),
    prefix: Type.Optional(text),
    registered_at: Type.Optional(text),
  },
  {
    $id: 'Workspace',
    ...extension,
    description: 'One registered root; storage retains project_id.',
  },
);
const ticket = (kind: 'spec' | 'task' | 'doc', id: string) =>
  Type.Object(
    {
      ...TicketCreated.properties,
      kind: Type.Literal(kind),
    },
    { $id: id, ...extension },
  );
export const Spec = ticket('spec', 'Spec');
export const Task = ticket('task', 'Task');
export const Doc = ticket('doc', 'Doc');
export const Agent = Type.Object(
  {
    session_id: text,
    name: Type.Optional(nullableText),
    role: Type.Optional(nullableText),
    project_id: Type.Optional(nullableText),
    team_id: Type.Optional(nullableText),
    profile: Type.Optional(nullableText),
    harness: Type.Optional(nullableText),
    state: Type.Optional(text),
  },
  {
    $id: 'Agent',
    ...extension,
    description: 'Roster identity; one native run remains a Session.',
  },
);
export const Session = Type.Object(
  {
    session_id: text,
    harness: Type.Optional(text),
    project_id: Type.Optional(nullableText),
    cwd: Type.Optional(nullableText),
    started_at: Type.Optional(nullableText),
    updated_at: Type.Optional(nullableText),
    ended_at: Type.Optional(nullableText),
    lifecycle_state: Type.Optional(text),
  },
  { $id: 'Session', ...extension },
);
export const Team = Type.Object(
  {
    team_id: text,
    project_id: text,
    label: text,
    slug: text,
    owner_session_id: Type.Optional(nullableText),
    members: Type.Array(text),
    created_at: Type.Optional(text),
  },
  { $id: 'Team', ...extension },
);
export const Profile = Type.Object(
  {
    name: text,
    harness: Type.Optional(text),
    provider: Type.Union([text, Type.Null()]),
    model: text,
    thinking: Type.Union([text, Type.Null()]),
  },
  {
    $id: 'Profile',
    ...extension,
    description: 'Execution profile, not the instance-home profile.',
  },
);
export const Role = Type.Object(
  {
    name: text,
    color: text,
    glyph: text,
    builtin: Type.Boolean(),
    card: Type.Optional(nullableText),
  },
  { $id: 'Role', ...extension },
);
const provisional = (id: string, description: string) => ({
  $id: id,
  ...extension,
  description,
  $comment:
    'provisional: true; schema_version 1; revise through explicit migration, no storage implemented in Stage 0',
});
export const NeedsYouItem = Type.Object(
  {
    schema_version: Type.Literal(1),
    id: text,
    project_id: nullableText,
    source: Type.Union(
      ['ticket', 'comment', 'gate', 'blocked', 'reminder'].map((v) =>
        Type.Literal(v),
      ),
    ),
    source_id: text,
    title: text,
    action: Type.Union(
      ['decide', 'reply', 'approve', 'unblock', 'acknowledge'].map((v) =>
        Type.Literal(v),
      ),
    ),
    created_at: text,
    resolved_at: nullableText,
  },
  provisional(
    'NeedsYouItem',
    'D-06 a: one inbox; resolving an item writes back to its source.',
  ),
);
export const StatusLine = Type.Object(
  {
    schema_version: Type.Literal(1),
    session_id: text,
    text,
    updated_at: text,
    milestone_id: Type.Optional(nullableText),
  },
  provisional(
    'StatusLine',
    'D-07 a: one line per agent, alongside milestones; raw journal hidden by default.',
  ),
);
export const You = Type.Object(
  {
    schema_version: Type.Literal(1),
    id: text,
    name: text,
    preferences: Type.Record(text, Type.Ref(JsonValue)),
    devices: Type.Array(Type.Object({ id: text, name: text }, extension)),
  },
  provisional(
    'You',
    'D-09 a: one local identity under this instance home; no account/auth implementation.',
  ),
);
export type WorkspaceValue = Static<typeof Workspace>;
export type NeedsYouItemValue = Static<typeof NeedsYouItem>;
export type StatusLineValue = Static<typeof StatusLine>;
export type YouValue = Static<typeof You>;
export const entitySchemas = {
  Workspace,
  Spec,
  Task,
  Doc,
  Agent,
  Session,
  Team,
  Profile,
  Role,
  NeedsYouItem,
  StatusLine,
  You,
};
