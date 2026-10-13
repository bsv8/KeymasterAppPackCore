import { ERROR_CODES, KeymasterError } from "./errors.js";
import { hexToBytes, isLowerHex } from "./encoding.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { AppMetadataV1, AppRequirementV1 } from "./types.js";

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u;
const REQ_PATTERN = /^(?:private-key|storage)$/u;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const a = Object.keys(value).sort();
  const b = [...keys].sort();
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/** 校验入口 HTML 与派生 JSON 中使用的完整 app metadata。 */
export function validateAppMetadata(value: unknown): AppMetadataV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new KeymasterError(ERROR_CODES.METADATA_INVALID, "metadata must be an object");
  const object = value as Record<string, unknown>;
  if (!exactKeys(object, ["version", "publisherPublicKey", "app", "requirements"]))
    throw new KeymasterError(ERROR_CODES.METADATA_INVALID, "metadata has unexpected fields");
  if (
    object.version !== 1 ||
    !isLowerHex(object.publisherPublicKey, 33) ||
    !/^(02|03)/u.test(object.publisherPublicKey as string)
  )
    throw new KeymasterError(ERROR_CODES.METADATA_INVALID, "invalid publisher public key");
  try {
    if (
      !secp256k1.utils.isValidPublicKey(
        hexToBytes(object.publisherPublicKey as string, 33, "publisher public key"),
      )
    )
      throw new Error("invalid point");
  } catch {
    throw new KeymasterError(ERROR_CODES.METADATA_INVALID, "invalid publisher public key");
  }
  if (!object.app || typeof object.app !== "object" || Array.isArray(object.app))
    throw new KeymasterError(ERROR_CODES.METADATA_INVALID, "metadata app must be an object");
  const app = object.app as Record<string, unknown>;
  if (
    !exactKeys(app, ["id", "name", "description"]) ||
    typeof app.id !== "string" ||
    !ID_PATTERN.test(app.id)
  )
    throw new KeymasterError(ERROR_CODES.METADATA_INVALID, "invalid app id");
  if (
    typeof app.name !== "string" ||
    !app.name.trim() ||
    app.name !== app.name.trim() ||
    [...app.name].length > 120 ||
    [...app.name].some((c) => /[\u0000-\u001f\u007f-\u009f\ufffd]/u.test(c))
  )
    throw new KeymasterError(ERROR_CODES.METADATA_INVALID, "invalid app name");
  if (
    typeof app.description !== "string" ||
    !app.description.trim() ||
    app.description !== app.description.trim() ||
    [...app.description].length > 500 ||
    [...app.description].some((c) => /[\u0000-\u001f\u007f-\u009f\ufffd]/u.test(c))
  )
    throw new KeymasterError(ERROR_CODES.METADATA_INVALID, "invalid app description");
  if (!Array.isArray(object.requirements))
    throw new KeymasterError(
      ERROR_CODES.METADATA_INVALID,
      "metadata requirements must be an array",
    );
  const requirements = object.requirements.map((requirement) => {
    if (typeof requirement !== "string" || !REQ_PATTERN.test(requirement))
      throw new KeymasterError(ERROR_CODES.UNKNOWN_REQUIREMENT, "unknown app requirement");
    return requirement as AppRequirementV1;
  });
  if (
    new Set(requirements).size !== requirements.length ||
    requirements.some((requirement, index) => index > 0 && requirements[index - 1]! >= requirement)
  )
    throw new KeymasterError(
      ERROR_CODES.METADATA_INVALID,
      "requirements must be sorted and unique",
    );
  return {
    version: 1,
    publisherPublicKey: object.publisherPublicKey as string,
    app: {
      id: app.id as string,
      name: app.name as string,
      description: app.description as string,
    },
    requirements,
  };
}

/** 仅将 HTML 真值投影为固定字段顺序的派生 app JSON。 */
export function metadataJson(value: AppMetadataV1): string {
  return `${JSON.stringify(validateAppMetadata(value))}\n`;
}
