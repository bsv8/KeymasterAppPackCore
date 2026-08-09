import { createReadStream } from "node:fs";
import { createSeed } from "masterseed";
import { ERROR_CODES, KeymasterError, throwIfAborted } from "./errors.js";

type Bytes = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

export async function seedHash(source: Bytes, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  try {
    const info = await createSeed(source, { write: () => undefined }, signal);
    return info.seedHashHex;
  } catch (error) {
    if (error instanceof KeymasterError) throw error;
    throw new KeymasterError(
      ERROR_CODES.SEED_HASH_MISMATCH,
      "unable to calculate MasterSeed hash",
      {},
      error,
    );
  }
}

export async function seedHashBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  return seedHash([bytes], signal);
}

export async function seedHashFile(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const stream = createReadStream(path);
  try {
    return await seedHash(stream as AsyncIterable<Uint8Array>, signal);
  } finally {
    stream.destroy();
  }
}
