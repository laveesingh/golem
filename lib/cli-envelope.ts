// The CLI wire boundary. Domain receipts stay flat; arrays become `items`.
export type CliFields = Record<string, unknown>;
export type CliEnvelope = CliFields & { schema_version: number; ok: boolean };

export function ok(fields: CliFields, schemaVersion = 1): CliEnvelope {
  return { ...fields, schema_version: schemaVersion, ok: true };
}
export function fail(
  code: string,
  message: string,
  details?: unknown,
): CliEnvelope {
  return {
    schema_version: 1,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}
export function emitJson(
  stdout: (text: string) => unknown,
  envelope: CliEnvelope,
): void {
  stdout(JSON.stringify(envelope));
}

// Adapt domain outcomes, not stdout text. Preserve management recovery fields.
export function envelope(value: CliFields | unknown[]): CliEnvelope {
  const fields = Array.isArray(value) ? { items: value } : value;
  const version =
    typeof fields.schema_version === 'number' ? fields.schema_version : 1;
  if (fields.ok === false) {
    const error = fields.error;
    const structured =
      error !== null && typeof error === 'object' ? (error as CliFields) : null;
    const code = String(structured?.code ?? fields.code ?? 'CLI_FAILED');
    const message = String(
      structured?.message ??
        fields.message ??
        error ??
        fields.reason ??
        'operation failed',
    );
    return {
      ...fields,
      ...fail(code, message, structured?.details),
      schema_version: version,
    };
  }
  return ok(fields, version);
}
export function formatJson(value: CliFields | unknown[]): string {
  let text = '';
  emitJson((output) => {
    text = output;
  }, envelope(value));
  return text;
}
