export const ERROR_CODES = {
  IDENTITY_INVALID: "IDENTITY_INVALID",
  IDENTITY_SIGNATURE_INVALID: "IDENTITY_SIGNATURE_INVALID",
  MANIFEST_INVALID: "MANIFEST_INVALID",
  BUNDLE_SIGNATURE_INVALID: "BUNDLE_SIGNATURE_INVALID",
  PUBLISHER_KEY_MISMATCH: "PUBLISHER_KEY_MISMATCH",
  LOGICAL_PATH_INVALID: "LOGICAL_PATH_INVALID",
  ENTRY_MISSING: "ENTRY_MISSING",
  MIME_CONFLICT: "MIME_CONFLICT",
  REFERENCE_MISSING: "REFERENCE_MISSING",
  BUNDLE_CYCLE: "BUNDLE_CYCLE",
  SEED_HASH_MISMATCH: "SEED_HASH_MISMATCH",
  UNDECLARED_FILE: "UNDECLARED_FILE",
  IDENTITY_EMBED_MISMATCH: "IDENTITY_EMBED_MISMATCH",
  SIGNER_UNAVAILABLE: "SIGNER_UNAVAILABLE",
  ATOMIC_WRITE_FAILED: "ATOMIC_WRITE_FAILED",
  OPERATION_ABORTED: "OPERATION_ABORTED",
  JSON_INVALID: "JSON_INVALID",
  JSON_DUPLICATE_KEY: "JSON_DUPLICATE_KEY",
  ENCODING_INVALID: "ENCODING_INVALID",
  REFERENCE_UNSUPPORTED: "REFERENCE_UNSUPPORTED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class KeymasterError extends Error {
  readonly code: ErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  readonly cause: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "KeymasterError";
    this.code = code;
    this.context = context;
    this.cause = cause;
  }
}

export function isKeymasterError(value: unknown): value is KeymasterError {
  return value instanceof KeymasterError;
}

export function fail(
  code: ErrorCode,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new KeymasterError(code, message, context);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new KeymasterError(
      ERROR_CODES.OPERATION_ABORTED,
      "operation was aborted",
      {},
      signal.reason,
    );
  }
}
