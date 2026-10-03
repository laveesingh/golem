import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import { JsonValue } from './pilot.ts';

const nullable = <T extends ReturnType<typeof Type.Object>>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const JsonObject = Type.Record(Type.String(), Type.Ref(JsonValue));
const Harness = Type.Object(
  {
    enabled: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    modelMap: Type.Optional(Type.Union([JsonObject, Type.Null()])),
    // Existing owner/setter treats this as opaque JSON metadata, not semver.
    testedVersion: Type.Optional(Type.Ref(JsonValue)),
  },
  { additionalProperties: Type.Ref(JsonValue) },
);
const fields = {
  dispatch: Type.Optional(
    nullable(
      Type.Object(
        {
          // Preserve valid zero/negative/fraction/null consumer semantics; validation
          // must not replace the consumers' established window policy or coerce data.
          unackedWindowMinutes: Type.Optional(
            Type.Union([Type.Number(), Type.Null()]),
          ),
        },
        { additionalProperties: Type.Ref(JsonValue) },
      ),
    ),
  ),
  harnesses: Type.Optional(
    Type.Union([
      Type.Record(Type.String(), Type.Union([Harness, Type.Null()])),
      Type.Null(),
    ]),
  ),
  roles: Type.Optional(
    nullable(
      Type.Object(
        {
          default: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        },
        { additionalProperties: Type.Ref(JsonValue) },
      ),
    ),
  ),
};
export const ConfigLegacy = Type.Object(fields, {
  $id: 'ConfigLegacy',
  additionalProperties: Type.Ref(JsonValue),
});
export const ConfigV1 = Type.Object(
  { schema_version: Type.Literal(1), ...fields },
  {
    $id: 'ConfigV1',
    additionalProperties: Type.Ref(JsonValue),
  },
);
export type Config = Static<typeof ConfigV1>;
export type LegacyConfig = Static<typeof ConfigLegacy>;
export type ConfigJson = Static<typeof JsonValue>;
