import { Ajv } from 'ajv';
import type { FastifyInstance } from 'fastify';

export function installContractPolicy(app: FastifyInstance): void {
  const body = new Ajv({
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    strict: false,
    allErrors: true,
  });
  const scalar = new Ajv({
    coerceTypes: true,
    useDefaults: false,
    removeAdditional: false,
    strict: false,
    allErrors: true,
  });
  app.setValidatorCompiler(({ schema, httpPart }) =>
    (httpPart === 'querystring' || httpPart === 'params'
      ? scalar
      : body
    ).compile(schema as object),
  );
}
export function pilotValidationError(
  body: unknown,
  message: string,
): { error: string; code: string } {
  const input =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (!input.project_id)
    return {
      error: 'createTicket: project_id is required',
      code: 'invalid_input',
    };
  if (!input.title)
    return { error: 'createTicket: title is required', code: 'invalid_input' };
  if (
    input.kind !== undefined &&
    !['task', 'spec', 'doc'].includes(String(input.kind))
  )
    return {
      error: `createTicket: invalid kind '${input.kind}'`,
      code: 'invalid_input',
    };
  if (
    input.body_format != null &&
    input.body_format !== '' &&
    !['markdown', 'html'].includes(String(input.body_format))
  )
    return {
      error: `invalid body_format '${input.body_format}'; expected markdown or html`,
      code: 'invalid_body_format',
    };
  // Named intentional type hardening under ES03: never coerce a body field.
  return { error: `createTicket: ${message}`, code: 'invalid_input' };
}
