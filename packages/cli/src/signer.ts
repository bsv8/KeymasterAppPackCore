import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ERROR_CODES, KeymasterError, bytesToHex, parseStrictJson } from "@keymaster-app-pack/core";
import type { PublisherSigner } from "@keymaster-app-pack/core";

interface EncryptedKeyFileV1 {
  version: 1;
  name: string;
  publicKey: string;
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface PublisherPublicKey {
  name: string;
  publicKey: string;
}

export function validatePublisherName(name: string): void {
  if (
    name === "." ||
    name === ".." ||
    name.length > 128 ||
    !/^[a-zA-Z0-9._-]+$/.test(name) ||
    name.startsWith("-")
  )
    throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "invalid publisher name");
}

function validatePublicKey(publicKey: string): void {
  if (!/^(02|03)[0-9a-f]{64}$/.test(publicKey)) throw new Error("invalid compressed public key");
  try {
    secp256k1.Point.fromHex(publicKey);
  } catch (error) {
    throw new Error("invalid compressed public key", { cause: error });
  }
}

function validateBase64Url(value: string, length: number): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoded key field");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value)
    throw new Error("invalid encoded key field");
}

function publisherFileName(name: string): string {
  return `${name}.publisher.key`;
}

function publisherNameFromPath(path: string): string {
  const file = basename(path);
  if (file.endsWith(".publisher.key")) return file.slice(0, -".publisher.key".length);
  return extname(file) === ".json" ? file.slice(0, -5) : file.replace(/\.key$/u, "");
}

function parsePublisherKeyFile(source: string, path: string): EncryptedKeyFileV1 {
  const value = parseStrictJson(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid key file");
  const object = value as Record<string, unknown>;
  const keys = ["version", "name", "publicKey", "salt", "nonce", "tag", "ciphertext"];
  if (Object.keys(object).sort().join("\0") !== keys.slice().sort().join("\0"))
    throw new Error("invalid key file");
  if (
    object.version !== 1 ||
    typeof object.name !== "string" ||
    typeof object.publicKey !== "string" ||
    typeof object.salt !== "string" ||
    typeof object.nonce !== "string" ||
    typeof object.tag !== "string" ||
    typeof object.ciphertext !== "string"
  ) throw new Error("invalid key file");
  const parsed = object as unknown as EncryptedKeyFileV1;
  validatePublisherName(parsed.name);
  if (parsed.name !== publisherNameFromPath(path)) throw new Error("key file name mismatch");
  validatePublicKey(parsed.publicKey);
  validateBase64Url(parsed.salt, 16);
  validateBase64Url(parsed.nonce, 12);
  validateBase64Url(parsed.tag, 16);
  validateBase64Url(parsed.ciphertext, 32);
  return parsed;
}

export class Secp256k1Signer implements PublisherSigner {
  readonly #privateKey: Uint8Array;

  constructor(privateKey: Uint8Array) {
    if (privateKey.length !== 32 || !secp256k1.utils.isValidSecretKey(privateKey))
      throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "invalid signer key");
    this.#privateKey = new Uint8Array(privateKey);
  }

  async getPublicKey(): Promise<string> {
    return bytesToHex(secp256k1.getPublicKey(this.#privateKey, true));
  }

  async signDigest(digest32: Uint8Array): Promise<Uint8Array> {
    if (digest32.length !== 32)
      throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "signer requires a 32-byte digest");
    return secp256k1.sign(digest32, this.#privateKey, { lowS: true, prehash: false });
  }
}

/** A memory signer intended for tests and process-local signer integrations. */
export class MemorySigner extends Secp256k1Signer {}

export async function writeEncryptedKeyFile(
  path: string,
  privateKey: Uint8Array,
  password: string,
  name = publisherNameFromPath(path),
  overwrite = true,
): Promise<void> {
  if (!password)
    throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "key-file password must not be empty");
  const signer = new Secp256k1Signer(privateKey);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  const file: EncryptedKeyFileV1 = {
    version: 1,
    name,
    publicKey: await signer.getPublicKey(),
    salt: salt.toString("base64url"),
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    validatePublisherName(name);
    if (!overwrite) {
      try {
        const target = await lstat(path);
        if (target.isSymbolicLink()) throw new Error("target is a symbolic link");
        throw new Error("target already exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await writeFile(temporaryPath, `${JSON.stringify(file)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    if (overwrite) await rename(temporaryPath, path);
    else {
      await link(temporaryPath, path);
      await rm(temporaryPath, { force: true });
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new KeymasterError(
      ERROR_CODES.ATOMIC_WRITE_FAILED,
      "unable to atomically write signer key file",
      { path },
      error,
    );
  }
}

export async function readEncryptedKeyFile(
  path: string,
  password: string,
  expectedName?: string,
): Promise<Secp256k1Signer> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("key file is not a regular file");
    const value = parsePublisherKeyFile(await readFile(path, "utf8"), path);
    if (expectedName !== undefined && value.name !== expectedName) throw new Error("key file name mismatch");
    const key = scryptSync(password, Buffer.from(value.salt, "base64url"), 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    const privateKey = new Uint8Array(
      Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, "base64url")),
        decipher.final(),
      ]),
    );
    const signer = new Secp256k1Signer(privateKey);
    if ((await signer.getPublicKey()) !== value.publicKey)
      throw new Error("key file public key mismatch");
    return signer;
  } catch (error) {
    throw new KeymasterError(
      ERROR_CODES.SIGNER_UNAVAILABLE,
      "unable to unlock signer key file",
      { path },
      error,
    );
  }
}

export class SignerRegistry {
  readonly #signers = new Map<string, PublisherSigner>();

  register(alias: string, signer: PublisherSigner): this {
    if (!/^[a-zA-Z0-9._-]+$/.test(alias) || alias.startsWith("-"))
      throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "invalid signer alias");
    this.#signers.set(alias, signer);
    return this;
  }

  get(alias: string): PublisherSigner {
    const signer = this.#signers.get(alias);
    if (!signer)
      throw new KeymasterError(
        ERROR_CODES.SIGNER_UNAVAILABLE,
        `signer alias is unavailable: ${alias}`,
        { alias },
      );
    return signer;
  }
}

export async function signerRegistryFromEnvironment(alias: string): Promise<SignerRegistry> {
  validatePublisherName(alias);
  const keyDir = process.env.KEYMASTER_PUBLISHER_KEY_DIR;
  const password = process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
  if (!keyDir || password === undefined || password.length === 0)
    throw new KeymasterError(
      ERROR_CODES.SIGNER_UNAVAILABLE,
      "set KEYMASTER_PUBLISHER_KEY_DIR and KEYMASTER_PUBLISHER_KEY_PASSWORD",
    );
  await assertKeyDirectory(keyDir);
  const keyPath = join(keyDir, publisherFileName(alias));
  return new SignerRegistry().register(alias, await readEncryptedKeyFile(keyPath, password, alias));
}

async function ensureKeyDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("key directory is not a directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await chmod(directory, 0o700);
}

async function assertKeyDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("key directory is not a directory");
  } catch (error) {
    throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "unable to read publisher key directory", { directory }, error);
  }
}

export async function createPublisherKey(
  name: string,
  directory: string | undefined = process.env.KEYMASTER_PUBLISHER_KEY_DIR,
  password: string | undefined = process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD,
): Promise<PublisherPublicKey> {
  validatePublisherName(name);
  if (!directory)
    throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "set KEYMASTER_PUBLISHER_KEY_DIR");
  if (password === undefined || password.length === 0)
    throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "set non-empty KEYMASTER_PUBLISHER_KEY_PASSWORD");
  await ensureKeyDirectory(directory);
  const path = join(directory, publisherFileName(name));
  const privateKey = secp256k1.utils.randomSecretKey();
  await writeEncryptedKeyFile(path, privateKey, password, name, false);
  return { name, publicKey: bytesToHex(secp256k1.getPublicKey(privateKey, true)) };
}

export async function listPublisherKeys(
  directory: string | undefined = process.env.KEYMASTER_PUBLISHER_KEY_DIR,
): Promise<PublisherPublicKey[]> {
  if (!directory)
    throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "set KEYMASTER_PUBLISHER_KEY_DIR");
  let entries;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("key directory is not a directory");
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "unable to read publisher key directory", { directory }, error);
  }
  const result: PublisherPublicKey[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".publisher.key"))
      throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "unknown publisher key file", { file: entry.name });
    const path = join(directory, entry.name);
    try {
      const value = parsePublisherKeyFile(await readFile(path, "utf8"), path);
      if (entry.name !== publisherFileName(value.name)) throw new Error("key file name mismatch");
      result.push({ name: value.name, publicKey: value.publicKey });
    } catch (error) {
      throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "unable to read publisher key directory", { file: path }, error);
    }
  }
  result.sort((left, right) => left.name.localeCompare(right.name));
  return result;
}
