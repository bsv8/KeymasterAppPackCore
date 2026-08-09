import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ERROR_CODES, KeymasterError, bytesToHex, hexToBytes } from "@keymaster-app-pack/core";
import type { PublisherSigner } from "@keymaster-app-pack/core";

interface EncryptedKeyFileV1 {
  version: 1;
  publicKey: string;
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
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
    publicKey: await signer.getPublicKey(),
    salt: salt.toString("base64url"),
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(file)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
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
): Promise<Secp256k1Signer> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as EncryptedKeyFileV1;
    if (
      value.version !== 1 ||
      typeof value.publicKey !== "string" ||
      typeof value.salt !== "string" ||
      typeof value.nonce !== "string" ||
      typeof value.tag !== "string" ||
      typeof value.ciphertext !== "string"
    )
      throw new Error("invalid key file");
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
  const keyPath = process.env.KEYMASTER_PUBLISHER_KEY_FILE;
  const password = process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
  if (!keyPath || password === undefined)
    throw new KeymasterError(
      ERROR_CODES.SIGNER_UNAVAILABLE,
      "set KEYMASTER_PUBLISHER_KEY_FILE and KEYMASTER_PUBLISHER_KEY_PASSWORD",
    );
  return new SignerRegistry().register(alias, await readEncryptedKeyFile(keyPath, password));
}
