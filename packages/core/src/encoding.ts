import { ERROR_CODES, KeymasterError } from "./errors.js";

const HEX = /^[0-9a-f]+$/;

export function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function hexToBytes(value: string, length: number, field = "hex"): Uint8Array {
  if (value.length !== length * 2 || !HEX.test(value)) {
    throw new KeymasterError(
      ERROR_CODES.ENCODING_INVALID,
      `${field} must be lowercase hexadecimal`,
      {
        field,
      },
    );
  }
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function isLowerHex(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length * 2 && HEX.test(value);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new KeymasterError(ERROR_CODES.ENCODING_INVALID, "invalid base64url encoding");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (encodeBase64Url(bytes) !== value) {
    throw new KeymasterError(ERROR_CODES.ENCODING_INVALID, "non-canonical base64url encoding");
  }
  return bytes;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}
