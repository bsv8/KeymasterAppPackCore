import { sha256 } from "@noble/hashes/sha2.js";
import { ERROR_CODES, KeymasterError } from "./errors.js";
import { parseStrictJson } from "./strict-json.js";

function assertJsonValue(value: unknown): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new KeymasterError(ERROR_CODES.JSON_INVALID, "non-finite JSON number");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item);
    return;
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) !== null &&
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new KeymasterError(ERROR_CODES.JSON_INVALID, "JCS value must be a JSON object");
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(key);
      assertJsonValue(item);
    }
    return;
  }
  throw new KeymasterError(ERROR_CODES.JSON_INVALID, "value is not JSON compatible");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

export function jcs(value: unknown): string {
  assertJsonValue(value);
  return canonicalize(value);
}

export function jcsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(jcs(value));
}

export function jcsDigest(value: unknown): Uint8Array {
  return sha256(jcsBytes(value));
}

export function parseStrictJcs(source: string): unknown {
  const value = parseStrictJson(source);
  if (jcs(value) !== source) {
    throw new KeymasterError(ERROR_CODES.JSON_INVALID, "JSON is not canonical JCS");
  }
  return value;
}
