import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  hashBundleFiles,
  injectIdentityMeta,
  signBundleManifest,
  signIdentityProof,
  verifyDeployment,
  writeHashedBundle,
} from "@keymaster-app-pack/core";
import {
  MemorySigner,
  SignerRegistry,
  readEncryptedKeyFile,
  writeEncryptedKeyFile,
} from "../src/signer.js";
import { runCli } from "../src/index.js";

const key = secp256k1.utils.randomSecretKey();

describe("CLI signer workflow", () => {
  it("signs a verified unsigned manifest and refuses private-key argv", async () => {
    const signer = new MemorySigner(key);
    const proof = await signIdentityProof(signer, {
      version: 1,
      app: { id: "cli-test", name: "CLI Test" },
    });
    const index = new TextEncoder().encode(
      injectIdentityMeta("<html><head></head><body>test</body></html>", proof),
    );
    const hashed = await hashBundleFiles([{ logicalPath: "index.html", bytes: index }]);
    const unsigned = {
      version: 1 as const,
      publisherPublicKey: proof.publisherPublicKey,
      app: proof.app,
      identitySignature: proof.signature,
      index: hashed.logicalToHash["index.html"]!,
      files: hashed.logicalToHash,
      bundleSignature: "",
    };
    const root = await mkdtemp(join(tmpdir(), "keymaster-cli-"));
    const dist = join(root, "dist");
    await writeHashedBundle(dist, hashed, unsigned);
    const registry = new SignerRegistry().register("test", signer);
    await runCli(["bundle", "sign", join(dist, ".keymaster.json"), "--key", "test"], {
      cwd: root,
      signers: registry,
      stdout: () => undefined,
    });
    await expect(verifyDeployment(dist)).resolves.toBeTruthy();
    await expect(
      runCli(
        [
          "bundle",
          "sign",
          join(dist, ".keymaster.json"),
          "--private-key",
          "not-forwarded",
          "--key",
          "test",
        ],
        { cwd: root, signers: registry },
      ),
    ).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
  });

  it("writes encrypted signer keys through an atomic temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-key-file-"));
    const path = join(root, "publisher.key");
    await writeEncryptedKeyFile(path, key, "test-password");
    const first = await readEncryptedKeyFile(path, "test-password");
    expect(await first.getPublicKey()).toBe(await new MemorySigner(key).getPublicKey());
    await writeEncryptedKeyFile(path, key, "test-password");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.includes(".tmp-")).length).toBe(0);
  });
});
