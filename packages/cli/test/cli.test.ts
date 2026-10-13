import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  hashBundleFiles,
  identitySigningDigest,
  signBundleManifest,
  verifyDeployment,
  writeHashedBundle,
} from "@keymaster-app-pack/core";
import type { AppMetadataV1 } from "@keymaster-app-pack/core";
import {
  MemorySigner,
  SignerRegistry,
  createPublisherKey,
  listPublisherKeys,
  readEncryptedKeyFile,
  signerRegistryFromEnvironment,
  writeEncryptedKeyFile,
} from "../src/signer.js";
import { runCli } from "../src/index.js";

const key = secp256k1.utils.randomSecretKey();

function metadata(): AppMetadataV1 {
  return {
    version: 1,
    publisherPublicKey: Buffer.from(secp256k1.getPublicKey(key, true)).toString("hex"),
    app: { id: "cli-test", name: "CLI Test", description: "CLI metadata" },
    requirements: ["storage"],
  };
}

function metadataHtml(value: AppMetadataV1): string {
  const signature = Buffer.from(secp256k1.sign(identitySigningDigest(value), key, { lowS: true, prehash: false })).toString("hex");
  return `<meta name="keymaster-app:id" content="${value.app.id}"><meta name="keymaster-app:publisher-public-key" content="${value.publisherPublicKey}"><meta name="keymaster-app:name" content="${value.app.name}"><meta name="keymaster-app:description" content="${value.app.description}"><meta name="keymaster-app:requirement" content="storage"><meta name="keymaster-app:identity-signature" content="${signature}">`;
}

describe("CLI signer workflow", () => {
  it("signs a verified unsigned manifest and refuses private-key argv", async () => {
    const signer = new MemorySigner(key);
    const value = metadata();
    const index = new TextEncoder().encode(
      `<html><head>${metadataHtml(value)}</head><body>test</body></html>`,
    );
    const hashed = await hashBundleFiles([{ logicalPath: "index.html", bytes: index }]);
    const unsigned = {
      ...value,
      identitySignature: Buffer.from(secp256k1.sign(identitySigningDigest(value), key, { lowS: true, prehash: false })).toString("hex"),
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

  it("creates and lists encrypted publishers without a password", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-publishers-"));
    const first = await createPublisherKey("zeta", root, "test-password");
    const second = await createPublisherKey("alpha", root, "test-password");
    await expect(listPublisherKeys(root)).resolves.toEqual([second, first]);
    expect((await stat(join(root, "alpha.publisher.key"))).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.includes(".tmp-")).length).toBe(0);
    const saved = process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
    delete process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
    try {
      await expect(listPublisherKeys(root)).resolves.toHaveLength(2);
    } finally {
      if (saved === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
      else process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD = saved;
    }
  });

  it("exposes publisher create/list through the CLI JSON interface", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-publisher-cli-"));
    const previousDir = process.env.KEYMASTER_PUBLISHER_KEY_DIR;
    const previousPassword = process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
    process.env.KEYMASTER_PUBLISHER_KEY_DIR = root;
    process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD = "test-password";
    const output: string[] = [];
    try {
      await runCli(["publisher", "create", "cli-name"], { stdout: (line) => output.push(line) });
      const created = JSON.parse(output.pop()!) as { name: string; publicKey: string };
      expect(created.name).toBe("cli-name");
      delete process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
      await runCli(["publisher", "list"], { stdout: (line) => output.push(line) });
      expect(JSON.parse(output.pop()!)).toEqual([created]);
      await expect(runCli(["publisher", "create", "one", "two"])).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    } finally {
      if (previousDir === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_DIR;
      else process.env.KEYMASTER_PUBLISHER_KEY_DIR = previousDir;
      if (previousPassword === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
      else process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD = previousPassword;
    }
  });

  it("rejects duplicate and invalid publisher names", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-publisher-errors-"));
    await createPublisherKey("same", root, "test-password");
    const before = await readFile(join(root, "same.publisher.key"), "utf8");
    await expect(createPublisherKey("same", root, "test-password")).rejects.toMatchObject({ code: "ATOMIC_WRITE_FAILED" });
    expect(await readFile(join(root, "same.publisher.key"), "utf8")).toBe(before);
    await expect(createPublisherKey("../escape", root, "test-password")).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    await expect(createPublisherKey("missing-password", root, undefined)).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    await expect(createPublisherKey("missing-directory", undefined, "test-password")).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    await expect(listPublisherKeys(undefined)).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    await symlink(join(root, "same.publisher.key"), join(root, "link.publisher.key"));
    await expect(listPublisherKeys(root)).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
  });

  it("fails closed for damaged publisher files and resolves signer by name", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-publisher-damaged-"));
    await createPublisherKey("named", root, "test-password");
    const previousDir = process.env.KEYMASTER_PUBLISHER_KEY_DIR;
    const previousPassword = process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
    process.env.KEYMASTER_PUBLISHER_KEY_DIR = root;
    process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD = "test-password";
    try {
      const registry = await signerRegistryFromEnvironment("named");
      expect(await registry.get("named").getPublicKey()).toBe((await listPublisherKeys(root))[0]!.publicKey);
      await writeFile(join(root, "unknown.json"), "{}\n");
      await expect(listPublisherKeys(root)).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    } finally {
      if (previousDir === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_DIR;
      else process.env.KEYMASTER_PUBLISHER_KEY_DIR = previousDir;
      if (previousPassword === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
      else process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD = previousPassword;
    }
  });

  it("rejects malformed publisher files and extra CLI list arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-publisher-malformed-"));
    await createPublisherKey("broken", root, "test-password");
    const malformedPath = join(root, "broken.publisher.key");
    const malformed = JSON.parse(await readFile(malformedPath, "utf8")) as Record<string, unknown>;
    const originalTag = malformed.tag;
    malformed.tag = "AAAAAAAAAAAAAAAAAAAA";
    await writeFile(malformedPath, `${JSON.stringify(malformed)}\n`);
    await expect(listPublisherKeys(root)).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    malformed.tag = originalTag;
    malformed.ciphertext = "bad";
    await writeFile(malformedPath, `${JSON.stringify(malformed)}\n`);
    await expect(listPublisherKeys(root)).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    const previousDir = process.env.KEYMASTER_PUBLISHER_KEY_DIR;
    process.env.KEYMASTER_PUBLISHER_KEY_DIR = root;
    try {
      await expect(runCli(["publisher", "list", "junk"])).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    } finally {
      if (previousDir === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_DIR;
      else process.env.KEYMASTER_PUBLISHER_KEY_DIR = previousDir;
    }
  });

  it("loads the selected publisher from the environment directory for bundle sign", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-publisher-sign-"));
    const keyName = "environment-key";
    const keyPath = join(root, `${keyName}.publisher.key`);
    await writeEncryptedKeyFile(keyPath, key, "test-password", keyName, false);
    const value = metadata();
    const index = new TextEncoder().encode(
      `<html><head>${metadataHtml(value)}</head><body>test</body></html>`,
    );
    const hashed = await hashBundleFiles([{ logicalPath: "index.html", bytes: index }]);
    const unsigned = {
      ...value,
      identitySignature: Buffer.from(secp256k1.sign(identitySigningDigest(value), key, { lowS: true, prehash: false })).toString("hex"),
      index: hashed.logicalToHash["index.html"]!,
      files: hashed.logicalToHash,
      bundleSignature: "",
    };
    const dist = join(root, "dist");
    await writeHashedBundle(dist, hashed, unsigned);
    const previousDir = process.env.KEYMASTER_PUBLISHER_KEY_DIR;
    const previousPassword = process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
    process.env.KEYMASTER_PUBLISHER_KEY_DIR = root;
    process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD = "test-password";
    try {
      await runCli(["bundle", "sign", join(dist, ".keymaster.json"), "--key", keyName], {
        cwd: root,
        stdout: () => undefined,
      });
      await expect(verifyDeployment(dist)).resolves.toBeTruthy();
    } finally {
      if (previousDir === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_DIR;
      else process.env.KEYMASTER_PUBLISHER_KEY_DIR = previousDir;
      if (previousPassword === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
      else process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD = previousPassword;
    }
  });

  it("creates project app metadata without signer configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-app-create-"));
    const value = metadata();
    await writeFile(join(root, "index.html"), `<html><head>${metadataHtml(value)}</head></html>`);
    const output: string[] = [];
    const previousDir = process.env.KEYMASTER_PUBLISHER_KEY_DIR;
    const previousPassword = process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
    delete process.env.KEYMASTER_PUBLISHER_KEY_DIR;
    delete process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
    try {
      await runCli(["app", "create"], { cwd: root, stdout: (line) => output.push(line) });
      const result = JSON.parse(output[0]!) as { input: string; output: string; proof: Record<string, unknown> };
      expect(result.input).toBe(join(root, "index.html"));
      expect(result.output).toBe(join(root, "keymaster.app.json"));
      expect(result.proof.app).toEqual(value.app);
      expect(JSON.parse(await readFile(result.output, "utf8"))).toEqual(result.proof);
    } finally {
      if (previousDir === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_DIR;
      else process.env.KEYMASTER_PUBLISHER_KEY_DIR = previousDir;
      if (previousPassword === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
      else process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD = previousPassword;
    }
  });

  it("signs metadata without writing files and emits the exact signature meta", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-app-sign-"));
    const value = metadata();
    const source = `<html><head>${metadataHtml(value).replace(/<meta name="keymaster-app:identity-signature"[^>]*>/u, "")}</head></html>`;
    await writeFile(join(root, "index.html"), source);
    const output: string[] = [];
    await runCli(["app", "sign", "--publisher", "test"], {
      cwd: root,
      signers: new SignerRegistry().register("test", new MemorySigner(key)),
      stdout: (line) => output.push(line),
    });
    const result = JSON.parse(output[0]!) as { meta: string; signature: string };
    expect(result.meta).toBe(`<meta name="keymaster-app:identity-signature" content="${result.signature}">`);
    expect(await readFile(join(root, "index.html"), "utf8")).toBe(source);
    await expect(readdir(root)).resolves.toEqual(["index.html"]);
  });

  it("strictly validates app sign flags, signer identity, environment and existing signatures", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-app-sign-errors-"));
    const value = metadata();
    const unsigned = `<html><head>${metadataHtml(value).replace(/<meta name="keymaster-app:identity-signature"[^>]*>/u, "")}</head></html>`;
    await writeFile(join(root, "index.html"), unsigned);
    const registry = new SignerRegistry().register("test", new MemorySigner(key));
    await expect(runCli(["app", "sign"], { cwd: root, signers: registry })).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    await expect(runCli(["app", "sign", "--publisher", "test", "--publisher", "test"], { cwd: root, signers: registry })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await expect(runCli(["app", "sign", "--publisher", "test", "positional"], { cwd: root, signers: registry })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await expect(runCli(["app", "sign", "--publisher", "test", "--unknown"], { cwd: root, signers: registry })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await expect(runCli(["app", "sign", "--publisher", "test", "--private-key", "x"], { cwd: root, signers: registry })).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    await expect(runCli(["app", "sign", "--publisher", "test"], { cwd: root, signers: new SignerRegistry().register("test", new MemorySigner(secp256k1.utils.randomSecretKey())) })).rejects.toMatchObject({ code: "PUBLISHER_KEY_MISMATCH" });
    const before = await readFile(join(root, "index.html"), "utf8");
    const output: string[] = [];
    await runCli(["app", "sign", "--publisher", "test"], { cwd: root, signers: registry, stdout: (line) => output.push(line) });
    const result = JSON.parse(output[0]!) as { publisher: string; publisherPublicKey: string; signature: string; meta: string };
    expect(Object.keys(result).sort()).toEqual(["meta", "publisher", "publisherPublicKey", "signature"]);
    expect(result.publisher).toBe("test");
    expect(result.meta).toBe(`<meta name="keymaster-app:identity-signature" content="${result.signature}">`);
    expect(await readFile(join(root, "index.html"), "utf8")).toBe(before);
    const signed = `${before.replace("</head>", `${result.meta}</head>`)}`;
    await writeFile(join(root, "index.html"), signed);
    await expect(runCli(["app", "sign", "--publisher", "test"], { cwd: root, signers: registry })).resolves.toBe(0);
    await writeFile(join(root, "index.html"), `${signed.replace(result.meta, `${result.meta}${result.meta}`)}`);
    await expect(runCli(["app", "sign", "--publisher", "test"], { cwd: root, signers: registry })).rejects.toMatchObject({ code: "IDENTITY_INVALID" });
    await writeFile(join(root, "index.html"), signed.replace(result.signature, ""));
    await expect(runCli(["app", "sign", "--publisher", "test"], { cwd: root, signers: registry })).rejects.toMatchObject({ code: "IDENTITY_INVALID" });
    const previousDir = process.env.KEYMASTER_PUBLISHER_KEY_DIR;
    const previousPassword = process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
    await writeFile(join(root, "index.html"), unsigned);
    delete process.env.KEYMASTER_PUBLISHER_KEY_DIR;
    delete process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD;
    try {
      await expect(runCli(["app", "sign", "--publisher", "test"], { cwd: root })).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
      process.env.KEYMASTER_PUBLISHER_KEY_DIR = root;
      await expect(runCli(["app", "sign", "--publisher", "test"], { cwd: root })).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
      delete process.env.KEYMASTER_PUBLISHER_KEY_DIR;
      process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD = "password";
      await expect(runCli(["app", "sign", "--publisher", "test"], { cwd: root })).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    } finally {
      if (previousDir === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_DIR; else process.env.KEYMASTER_PUBLISHER_KEY_DIR = previousDir;
      if (previousPassword === undefined) delete process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD; else process.env.KEYMASTER_PUBLISHER_KEY_PASSWORD = previousPassword;
    }
  });

  it("supports explicit paths and atomic replacement while rejecting unknown arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-app-create-flags-"));
    const value = metadata();
    const input = join(root, "source.html");
    const output = join(root, "meta", "app.json");
    await writeFile(input, `<html><head>${metadataHtml(value)}</head></html>`);
    await mkdir(join(root, "meta"));
    await runCli(["app", "create", "--input", input, "--out", output], { cwd: root });
    const before = await readFile(output, "utf8");
    await expect(runCli(["app", "create", "--input", input, "--out", output], { cwd: root })).rejects.toMatchObject({ code: "ATOMIC_WRITE_FAILED" });
    expect(await readFile(output, "utf8")).toBe(before);
    await expect(runCli(["app", "create", "--input", input, "--out", output, "--replace", "--unknown"], { cwd: root })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await expect(runCli(["app", "create", "--input", input, "--input", input], { cwd: root })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await expect(runCli(["app", "create", "--out", output, "--out", output], { cwd: root })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await expect(runCli(["app", "create", "--replace", "--replace"], { cwd: root })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await expect(runCli(["app", "create", "--input", "index.html", "--out", "index.html", "--replace"], { cwd: root })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await runCli(["app", "create", "--input", input, "--out", output, "--replace"], { cwd: root });
    expect((await readdir(join(root, "meta"))).filter((name) => name.includes(".tmp-") || name.includes(".previous-")).length).toBe(0);
    const directoryTarget = join(root, "target-dir");
    await mkdir(directoryTarget);
    await writeFile(join(directoryTarget, "keep.txt"), "keep");
    await expect(runCli(["app", "create", "--input", input, "--out", directoryTarget, "--replace"], { cwd: root })).rejects.toMatchObject({ code: "ATOMIC_WRITE_FAILED" });
    await expect(readFile(join(directoryTarget, "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it("rejects missing or tampered proof for app create without consulting signer env", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-app-create-proof-"));
    const value = metadata();
    const signed = metadataHtml(value);
    const input = join(root, "index.html");
    const output = join(root, "keymaster.app.json");
    await writeFile(input, `<html><head>${signed}</head></html>`);
    const original = await readFile(input, "utf8");
    await runCli(["app", "create"], { cwd: root });
    expect(await readFile(input, "utf8")).toBe(original);
    await writeFile(input, `<html><head>${signed.replace(/content="[0-9a-f]{128}"/u, `content="${"0".repeat(128)}"`)}</head></html>`);
    await expect(runCli(["app", "create", "--replace"], { cwd: root })).rejects.toMatchObject({ code: "IDENTITY_SIGNATURE_INVALID" });
    await writeFile(input, `<html><head>${signed.replace(/<meta name="keymaster-app:identity-signature"[^>]*>/u, "")}</head></html>`);
    await expect(runCli(["app", "create", "--replace"], { cwd: root })).rejects.toMatchObject({ code: "IDENTITY_INVALID" });
  });
});
