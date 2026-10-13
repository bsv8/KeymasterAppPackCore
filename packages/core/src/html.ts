import { ERROR_CODES, KeymasterError } from "./errors.js";
import { validateAppMetadata } from "./metadata.js";
import { assertIdentityProof, validateIdentityProof } from "./identity.js";
import type { AppIdentityProofV1, AppMetadataV1 } from "./types.js";

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

/**
 * 从入口 HTML 读取唯一 app metadata 真值。
 * 项目 app JSON 与部署 manifest 都由这组字段派生，避免多个来源分叉。
 */
export function extractAppMetadata(html: string): AppMetadataV1 {
  const tags = findTags(html).filter((tag) => tag.name === "meta");
  const values = new Map<string, string[]>();
  for (const tag of tags) {
    const name = tag.attributes.get("name")?.value?.toLowerCase();
    if (!name?.startsWith("keymaster-app:")) continue;
    if (
      ![
        "keymaster-app:id",
        "keymaster-app:publisher-public-key",
        "keymaster-app:name",
        "keymaster-app:description",
        "keymaster-app:requirement",
        "keymaster-app:identity-signature",
      ].includes(name)
    )
      throw new KeymasterError(ERROR_CODES.METADATA_INVALID, `unknown app metadata: ${name}`);
    const content = tag.attributes.get("content")?.value;
    if (content !== undefined) values.set(name, [...(values.get(name) ?? []), content]);
  }
  const one = (name: string): string => {
    const entries = values.get(name) ?? [];
    if (entries.length !== 1 || !entries[0]!.trim())
      throw new KeymasterError(ERROR_CODES.METADATA_INVALID, `${name} must appear exactly once`);
    if (entries[0] !== entries[0]!.trim())
      throw new KeymasterError(
        ERROR_CODES.METADATA_INVALID,
        `${name} must not have surrounding whitespace`,
      );
    return entries[0]!;
  };
  const requirement = values.get("keymaster-app:requirement") ?? [];
  const signatureTags = identitySignatureTags(html);
  if (signatureTags.length > 1)
    throw new KeymasterError(
      ERROR_CODES.IDENTITY_INVALID,
      "identity signature meta must appear at most once",
    );
  if (signatureTags.length === 1 && !signatureTags[0]!.attributes.get("content")?.value)
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "identity signature meta content is empty");
  return validateAppMetadata({
    version: 1,
    publisherPublicKey: one("keymaster-app:publisher-public-key"),
    app: {
      id: one("keymaster-app:id"),
      name: one("keymaster-app:name"),
      description: one("keymaster-app:description"),
    },
    requirements: requirement,
  });
}

function identitySignatureTags(html: string): HtmlTag[] {
  return findTags(html).filter(
    (tag) =>
      tag.name === "meta" &&
      tag.attributes.get("name")?.value?.toLowerCase() === "keymaster-app:identity-signature",
  );
}

/** 从 HTML 读取并验证完整 identity proof；构建和运行时必须走此入口。 */
export function extractAppIdentityProof(html: string): AppIdentityProofV1 {
  const matches = identitySignatureTags(html);
  if (matches.length !== 1)
    throw new KeymasterError(
      ERROR_CODES.IDENTITY_INVALID,
      "HTML must contain exactly one identity signature meta",
    );
  const signature = matches[0]!.attributes.get("content")?.value;
  if (!signature)
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "identity signature meta content is empty");
  const proof = validateIdentityProof({ ...extractAppMetadata(html), signature });
  assertIdentityProof(proof);
  return proof;
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
