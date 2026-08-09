import { ERROR_CODES, KeymasterError } from "./errors.js";

interface CssReference {
  start: number;
  end: number;
  value: string;
}

function references(source: string): CssReference[] {
  const result: CssReference[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    const character = source[index]!;
    if (character === '"' || character === "'") {
      index = skipString(source, index);
      continue;
    }
    if (/url/i.test(source.slice(index, index + 3)) && /[\s(]/u.test(source[index + 3] ?? "")) {
      let cursor = index + 3;
      while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
      if (source[cursor] !== "(") {
        index += 1;
        continue;
      }
      cursor += 1;
      while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      const start = cursor;
      let value: string;
      let valueStart = cursor;
      if (quote === '"' || quote === "'") {
        cursor += 1;
        valueStart = cursor;
        cursor = skipString(source, start);
        value = source.slice(valueStart, cursor - 1);
      } else {
        valueStart = cursor;
        while (cursor < source.length && source[cursor] !== ")") cursor += 1;
        value = source.slice(valueStart, cursor).trim();
        const raw = source.slice(valueStart, cursor);
        const left = raw.match(/^\s*/u)?.[0].length ?? 0;
        const right = raw.match(/\s*$/u)?.[0].length ?? 0;
        result.push({ start: valueStart + left, end: cursor - right, value });
        index = cursor + 1;
        continue;
      }
      result.push({ start: valueStart, end: cursor - 1, value });
      index = source.indexOf(")", cursor) + 1 || source.length;
      continue;
    }
    if (source[index] === "@" && /^@import\b/i.test(source.slice(index))) {
      let cursor = index + 7;
      while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        const start = cursor + 1;
        cursor = skipString(source, cursor);
        result.push({ start, end: cursor - 1, value: source.slice(start, cursor - 1) });
        index = cursor;
        continue;
      }
    }
    index += 1;
  }
  return result;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

export function extractCssReferences(source: string): string[] {
  return [...new Set(references(source).map((item) => item.value))];
}

export function replaceCssReferences(
  source: string,
  replacements: ReadonlyMap<string, string>,
  resolve: (reference: string) => string | undefined,
): string {
  let output = source;
  const changes: Array<{ start: number; end: number; value: string }> = [];
  for (const reference of references(source)) {
    const target = resolve(reference.value);
    if (!target) continue;
    const replacement = replacements.get(target);
    if (!replacement)
      throw new KeymasterError(
        ERROR_CODES.REFERENCE_MISSING,
        `CSS reference has no content hash: ${target}`,
      );
    const fragment = reference.value.includes("#")
      ? reference.value.slice(reference.value.indexOf("#"))
      : "";
    changes.push({
      start: reference.start,
      end: reference.end,
      value: `${replacement}${fragment}`,
    });
  }
  for (const change of changes.sort((a, b) => b.start - a.start))
    output = `${output.slice(0, change.start)}${change.value}${output.slice(change.end)}`;
  return output;
}
