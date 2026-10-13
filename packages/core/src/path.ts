import { ERROR_CODES, KeymasterError } from "./errors.js";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function validateLogicalPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new KeymasterError(
      ERROR_CODES.LOGICAL_PATH_INVALID,
      "logical path has an invalid length",
    );
  }
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    CONTROL.test(value) ||
    value.includes("\0")
  ) {
    throw new KeymasterError(
      ERROR_CODES.LOGICAL_PATH_INVALID,
      "logical path must be a relative POSIX path",
      { value },
    );
  }
  const parts = value.split("/");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === ".." || part.length > 255)
  ) {
    throw new KeymasterError(
      ERROR_CODES.LOGICAL_PATH_INVALID,
      "logical path contains an invalid segment",
      { value },
    );
  }
  if (value === ".keymaster.json" || value.startsWith(".keymaster.json/") || value === "keymaster.app.json" || value.startsWith("keymaster.app.json/")) {
    throw new KeymasterError(ERROR_CODES.LOGICAL_PATH_INVALID, "logical path is reserved", {
      value,
    });
  }
}

export function normalizeLogicalPath(value: string): string {
  const result = value.replaceAll("\\", "/");
  validateLogicalPath(result);
  return result;
}

export function relativeLogicalPath(from: string, to: string): string {
  validateLogicalPath(from);
  validateLogicalPath(to);
  const fromParts = from.split("/");
  fromParts.pop();
  const toParts = to.split("/");
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  )
    common += 1;
  const result =
    [...fromParts.slice(common).map(() => ".."), ...toParts.slice(common)].join("/") || ".";
  return result;
}

export function resolveRelativeLogicalPath(from: string, reference: string): string | undefined {
  validateLogicalPath(from);
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) return undefined;
  const clean = reference.split(/[?#]/, 1)[0]!;
  if (clean.length === 0) return from;
  const base = from.split("/");
  base.pop();
  const parts = clean.startsWith("/") ? clean.slice(1).split("/") : [...base, ...clean.split("/")];
  const output: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (output.length === 0) return undefined;
      output.pop();
    } else output.push(part);
  }
  const result = output.join("/");
  try {
    validateLogicalPath(result);
    return result;
  } catch {
    return undefined;
  }
}
