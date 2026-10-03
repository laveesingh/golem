import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import { ConfigLegacy, ConfigV1 } from './config.ts';
import { JsonValue } from './pilot.ts';

export { ConfigLegacy, ConfigV1 } from './config.ts';

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const dashboardFields = {
  url: Type.Optional(nullableString),
  host: Type.Optional(nullableString),
  port: Type.Optional(nullableNumber),
  pid: Type.Optional(nullableNumber),
  started_at: Type.Optional(nullableString),
};
const shareFields = {
  origin: Type.Optional(nullableString),
  publicPort: Type.Optional(nullableNumber),
  metricsPort: Type.Optional(nullableNumber),
  hostname: Type.Optional(nullableString),
  pid: Type.Optional(nullableNumber),
  updated_at: Type.Optional(nullableString),
};
export const DashboardLegacy = Type.Object(dashboardFields, {
  $id: 'DashboardLegacy',
  additionalProperties: Type.Ref(JsonValue),
});
export const DashboardV1 = Type.Object(
  { schema_version: Type.Literal(1), ...dashboardFields },
  {
    $id: 'DashboardV1',
    additionalProperties: Type.Ref(JsonValue),
  },
);
export const ShareTunnelLegacy = Type.Object(shareFields, {
  $id: 'ShareTunnelLegacy',
  additionalProperties: Type.Ref(JsonValue),
});
export const ShareTunnelV1 = Type.Object(
  { schema_version: Type.Literal(1), ...shareFields },
  {
    $id: 'ShareTunnelV1',
    additionalProperties: Type.Ref(JsonValue),
  },
);
export const JournalHeader = Type.Object(
  { schema_version: Type.Literal(1), kind: Type.Literal('journal') },
  {
    $id: 'JournalHeader',
    additionalProperties: false,
  },
);
export const SpoolHeader = Type.Object(
  { schema_version: Type.Literal(1), kind: Type.Literal('spool') },
  {
    $id: 'SpoolHeader',
    additionalProperties: false,
  },
);
export type DashboardStore = Static<typeof DashboardV1>;
export type ShareTunnelStore = Static<typeof ShareTunnelV1>;
export const storeSchemas = {
  ConfigLegacy,
  ConfigV1,
  DashboardLegacy,
  DashboardV1,
  ShareTunnelLegacy,
  ShareTunnelV1,
  JournalHeader,
  SpoolHeader,
};
