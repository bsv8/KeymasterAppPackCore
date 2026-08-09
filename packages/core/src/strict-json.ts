import { ERROR_CODES, KeymasterError } from "./errors.js";

function isWhitespace(value: string): boolean {
  return value === " " || value === "\n" || value === "\r" || value === "\t";
}

function scanString(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 0x22) return index + 1;
    if (code < 0x20)
      throw new KeymasterError(ERROR_CODES.JSON_INVALID, "control character in JSON string");
    if (code === 0x5c) {
      index += 1;
      if (index >= source.length) break;
      const escape = source[index];
      if (escape === "u") index += 4;
    }
    index += 1;
  }
  throw new KeymasterError(ERROR_CODES.JSON_INVALID, "unterminated JSON string");
}

function scanValue(source: string, start: number): number {
  const character = source[start];
  if (character === '"') return scanString(source, start);
  if (character === "[") {
    let index = start + 1;
    while (true) {
      while (index < source.length && isWhitespace(source[index]!)) index += 1;
      if (source[index] === "]") return index + 1;
      index = scanValue(source, index);
      while (index < source.length && isWhitespace(source[index]!)) index += 1;
      if (source[index] === "]") return index + 1;
      if (source[index] !== ",")
        throw new KeymasterError(ERROR_CODES.JSON_INVALID, "invalid JSON array");
      index += 1;
      while (index < source.length && isWhitespace(source[index]!)) index += 1;
      if (source[index] === "]")
        throw new KeymasterError(ERROR_CODES.JSON_INVALID, "trailing JSON comma");
    }
  }
  if (character === "{") {
    const keys = new Set<string>();
    let index = start + 1;
    while (true) {
      while (index < source.length && isWhitespace(source[index]!)) index += 1;
      if (source[index] === "}") return index + 1;
      if (source[index] !== '"')
        throw new KeymasterError(ERROR_CODES.JSON_INVALID, "object key must be a string");
      const keyEnd = scanString(source, index);
      let key: string;
      try {
        key = JSON.parse(source.slice(index, keyEnd)) as string;
      } catch (error) {
        throw new KeymasterError(ERROR_CODES.JSON_INVALID, "invalid JSON object key", {}, error);
      }
      if (keys.has(key)) {
        throw new KeymasterError(ERROR_CODES.JSON_DUPLICATE_KEY, `duplicate JSON key: ${key}`, {
          key,
        });
      }
      keys.add(key);
      index = keyEnd;
      while (index < source.length && isWhitespace(source[index]!)) index += 1;
      if (source[index] !== ":")
        throw new KeymasterError(ERROR_CODES.JSON_INVALID, "missing JSON colon");
      index += 1;
      while (index < source.length && isWhitespace(source[index]!)) index += 1;
      index = scanValue(source, index);
      while (index < source.length && isWhitespace(source[index]!)) index += 1;
      if (source[index] === "}") return index + 1;
      if (source[index] !== ",")
        throw new KeymasterError(ERROR_CODES.JSON_INVALID, "invalid JSON object");
      index += 1;
      while (index < source.length && isWhitespace(source[index]!)) index += 1;
      if (source[index] === "}")
        throw new KeymasterError(ERROR_CODES.JSON_INVALID, "trailing JSON comma");
    }
  }
  const end = source.slice(start).search(/[\s,\]}]/);
  return end < 0 ? source.length : start + end;
}

function rejectInvalidUnicode(value: unknown): void {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
          throw new KeymasterError(
            ERROR_CODES.JSON_INVALID,
            "lone UTF-16 surrogate in JSON string",
          );
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new KeymasterError(ERROR_CODES.JSON_INVALID, "lone UTF-16 surrogate in JSON string");
      }
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new KeymasterError(ERROR_CODES.JSON_INVALID, "non-finite JSON number");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectInvalidUnicode(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) rejectInvalidUnicode(item);
  }
}

export function parseStrictJson(source: string): unknown {
  if (typeof source !== "string" || source.length === 0) {
    throw new KeymasterError(ERROR_CODES.JSON_INVALID, "JSON source must not be empty");
  }
  let end: number;
  let value: unknown;
  try {
    let start = 0;
    while (start < source.length && isWhitespace(source[start]!)) start += 1;
    end = scanValue(source, start);
    let tail = end;
    while (tail < source.length && isWhitespace(source[tail]!)) tail += 1;
    if (tail !== source.length)
      throw new KeymasterError(ERROR_CODES.JSON_INVALID, "trailing JSON data");
    value = JSON.parse(source);
  } catch (error) {
    if (error instanceof KeymasterError) throw error;
    throw new KeymasterError(ERROR_CODES.JSON_INVALID, "invalid JSON", {}, error);
  }
  rejectInvalidUnicode(value);
  return value;
}
