import { ERROR_CODES, KeymasterError } from "./errors.js";
import { decodeIdentityProof, encodeIdentityProof } from "./identity.js";
import type { AppIdentityProofV1 } from "./types.js";

interface HtmlTag {
  start: number;
  end: number;
  name: string;
  attributes: Map<string, HtmlAttribute>;
}

interface HtmlAttribute {
  value: string | undefined;
  valueStart: number | undefined;
  valueEnd: number | undefined;
}

function tagAttributes(source: string, start: number, end: number): HtmlTag {
  let index = start + 1;
  while (index < end && /\s/u.test(source[index]!)) index += 1;
  const nameStart = index;
  while (index < end && !/[\s/>]/u.test(source[index]!)) index += 1;
  const name = source.slice(nameStart, index).toLowerCase();
  const attributes = new Map<string, HtmlAttribute>();
  while (index < end) {
    while (index < end && /[\s/]/u.test(source[index]!)) index += 1;
    if (index >= end || source[index] === ">") break;
    const keyStart = index;
    while (index < end && !/[\s=/>]/u.test(source[index]!)) index += 1;
    const key = source.slice(keyStart, index).toLowerCase();
    while (index < end && /\s/u.test(source[index]!)) index += 1;
    let value: string | undefined;
    let valueStart: number | undefined;
    let valueEnd: number | undefined;
    if (source[index] === "=") {
      index += 1;
      while (index < end && /\s/u.test(source[index]!)) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        valueStart = index;
        while (index < end && source[index] !== quote) index += 1;
        valueEnd = index;
        value = source.slice(valueStart, valueEnd);
        index += 1;
      } else {
        valueStart = index;
        while (index < end && !/[\s>]/u.test(source[index]!)) index += 1;
        valueEnd = index;
        value = source.slice(valueStart, valueEnd);
      }
    }
    attributes.set(key, { value, valueStart, valueEnd });
  }
  return { start, end, name, attributes };
}

function findTags(source: string): HtmlTag[] {
  const result: HtmlTag[] = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open < 0) break;
    if (source.startsWith("<!--", open)) {
      index = source.indexOf("-->", open + 4);
      if (index < 0) break;
      index += 3;
      continue;
    }
    let cursor = open + 1;
    let quote: string | undefined;
    while (cursor < source.length) {
      const character = source[cursor]!;
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      cursor += 1;
    }
    if (cursor >= source.length) break;
    const tag = tagAttributes(source, open, cursor + 1);
    result.push(tag);
    if (tag.name === "script" && !source.slice(open, cursor + 1).endsWith("/>")) {
      const closeMatch = /<\/script\s*>/i.exec(source.slice(cursor + 1));
      if (closeMatch) {
        index = cursor + 1 + closeMatch.index + closeMatch[0].length;
        continue;
      }
    }
    index = cursor + 1;
  }
  return result;
}

function isIdentityMeta(tag: HtmlTag): boolean {
  return (
    tag.name === "meta" &&
    tag.attributes.get("name")?.value?.toLowerCase() === "keymaster-app-identity"
  );
}

export function extractIdentityEncoded(html: string): string {
  const matches = findTags(html).filter(isIdentityMeta);
  if (matches.length !== 1)
    throw new KeymasterError(
      ERROR_CODES.IDENTITY_INVALID,
      "HTML must contain exactly one identity meta",
    );
  const encoded = matches[0]!.attributes.get("content")?.value;
  if (!encoded)
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "identity meta content is empty");
  return encoded;
}

export function extractIdentityProof(html: string): AppIdentityProofV1 {
  return decodeIdentityProof(extractIdentityEncoded(html));
}

export function extractHtmlReferences(html: string): string[] {
  const result = new Set<string>();
  for (const tag of findTags(html)) {
    if (
      tag.name !== "script" &&
      tag.name !== "link" &&
      tag.name !== "img" &&
      tag.name !== "source" &&
      tag.name !== "video" &&
      tag.name !== "audio" &&
      tag.name !== "iframe"
    )
      continue;
    for (const attribute of ["src", "href"]) {
      const value = tag.attributes.get(attribute)?.value;
      if (value) result.add(value);
    }
  }
  return [...result];
}

export function injectIdentityMeta(html: string, proof: AppIdentityProofV1): string {
  const encoded = encodeIdentityProof(proof);
  const tags = findTags(html);
  const existing = tags.filter(isIdentityMeta);
  let output = html;
  for (const tag of [...existing].reverse())
    output = `${output.slice(0, tag.start)}${output.slice(tag.end)}`;
  const meta = `<meta name="keymaster-app-identity" content="${encoded}">`;
  const headClose = output.search(/<\/head\s*>/i);
  if (headClose >= 0) return `${output.slice(0, headClose)}${meta}${output.slice(headClose)}`;
  const bodyOpen = output.search(/<body(?:\s[^>]*)?>/i);
  if (bodyOpen >= 0) return `${output.slice(0, bodyOpen)}${meta}${output.slice(bodyOpen)}`;
  return `${meta}${output}`;
}

export function replaceHtmlReferences(
  html: string,
  replacements: ReadonlyMap<string, string>,
  resolve: (reference: string) => string | undefined,
): string {
  const tags = findTags(html);
  const changes: Array<{ start: number; end: number; value: string }> = [];
  for (const tag of tags) {
    if (
      tag.name !== "script" &&
      tag.name !== "link" &&
      tag.name !== "img" &&
      tag.name !== "source" &&
      tag.name !== "video" &&
      tag.name !== "audio" &&
      tag.name !== "iframe"
    )
      continue;
    for (const attribute of ["src", "href"]) {
      const attributeValue = tag.attributes.get(attribute);
      const reference = attributeValue?.value;
      if (!reference) continue;
      const target = resolve(reference);
      if (!target) continue;
      const hash = replacements.get(target);
      if (!hash)
        throw new KeymasterError(
          ERROR_CODES.REFERENCE_MISSING,
          `HTML reference has no content hash: ${target}`,
        );
      const fragment = reference.includes("#") ? reference.slice(reference.indexOf("#")) : "";
      if (attributeValue.valueStart === undefined || attributeValue.valueEnd === undefined)
        continue;
      changes.push({
        start: attributeValue.valueStart,
        end: attributeValue.valueEnd,
        value: `${hash}${fragment}`,
      });
    }
  }
  let output = html;
  for (const change of changes.sort((a, b) => b.start - a.start))
    output = `${output.slice(0, change.start)}${change.value}${output.slice(change.end)}`;
  return output;
}
