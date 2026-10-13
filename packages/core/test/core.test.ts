import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  ERROR_CODES,
  KeymasterError,
  bundleSigningDigest,
  bytesToHex,
  createBundleGraph,
  extractAppMetadata,
  extractCssReferences,
  hashBundleFiles,
  identitySigningDigest,
  jcs,
  parseStrictJson,
  replaceCssReferences,
  replaceHtmlReferences,
  seedHashBytes,
  signBundleManifest,
  stableDependencyOrder,
  validateAppMetadata,
  validateLogicalPath,
  verifyBundleSignature,
  verifyDeployment,
  writeHashedBundle,
} from "../src/index.js";
import type { AppMetadataV1, KeymasterAppManifestV1, PublisherSigner } from "../src/index.js";

const privateKey = new Uint8Array(32);
privateKey[31] = 1;

function signer(key = privateKey): PublisherSigner {
  return {
    async getPublicKey() {
      return bytesToHex(secp256k1.getPublicKey(key, true));
    },
    async signDigest(digest) {
      return secp256k1.sign(digest, key, { lowS: true, prehash: false });
    },
  };
}

function metadata(overrides: Partial<AppMetadataV1["app"]> = {}): AppMetadataV1 {
  return {
    version: 1,
    publisherPublicKey: bytesToHex(secp256k1.getPublicKey(privateKey, true)),
    app: {
      id: "fixture",
      name: "Fixture",
      description: "Fixture metadata",
      ...overrides,
    },
    requirements: ["storage"],
  };
}

function metadataHtml(value: AppMetadataV1): string {
  const requirements = value.requirements
    .map((requirement) => `<meta name="keymaster-app:requirement" content="${requirement}">`)
    .join("");
  return `<meta name="keymaster-app:id" content="${value.app.id}"><meta name="keymaster-app:publisher-public-key" content="${value.publisherPublicKey}"><meta name="keymaster-app:name" content="${value.app.name}"><meta name="keymaster-app:description" content="${value.app.description}">${requirements}<meta name="keymaster-app:identity-signature" content="${identitySignature(value)}">`;
}

function identitySignature(value: AppMetadataV1): string {
  return Buffer.from(secp256k1.sign(identitySigningDigest(value), privateKey, { lowS: true, prehash: false })).toString("hex");
}

async function unsignedDeployment(
  value: AppMetadataV1 = metadata(),
  files: Array<{ logicalPath: string; bytes: Uint8Array }> = [
    {
      logicalPath: "index.html",
      bytes: new TextEncoder().encode(
        `<!doctype html><html><head>${metadataHtml(value)}</head><body>ok</body></html>`,
      ),
    },
  ],
): Promise<{
  root: string;
  hashed: Awaited<ReturnType<typeof hashBundleFiles>>;
  manifest: KeymasterAppManifestV1;
}> {
  const hashed = await hashBundleFiles(files);
  const manifest = await signBundleManifest(signer(), {
    ...value,
    identitySignature: identitySignature(value),
    index: hashed.logicalToHash["index.html"] ?? Object.values(hashed.logicalToHash)[0]!,
    files: hashed.logicalToHash,
    bundleSignature: "",
  });
  const root = await mkdtemp(join(tmpdir(), "keymaster-app-pack-"));
  await writeHashedBundle(root, hashed, manifest);
  return { root, hashed, manifest };
}

describe("Keymaster App Pack core", () => {
  it("canonicalizes objects, rejects duplicate keys and lone surrogates", () => {
    expect(jcs({ files: { b: 2, a: 1 }, app: "你好" })).toBe(
      '{"app":"你好","files":{"a":1,"b":2}}',
    );
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrowError(KeymasterError);
    expect(() => parseStrictJson('{"a":"\\ud800"}')).toThrowError(KeymasterError);
    expect(
      jcs({
        z: "€$𐍈",
        a: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27],
        m: { false: false, null: null, true: true },
      }),
    ).toBe(
      '{"a":[333333333.3333333,1e+30,4.5,0.002,1e-27],"m":{"false":false,"null":null,"true":true},"z":"€$𐍈"}',
    );
    expect(
      bytesToHex(
        bundleSigningDigest({
          version: 1,
          publisherPublicKey:
            "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          app: { id: "fixture", name: "Fixture", description: "Fixture metadata" },
          requirements: ["storage"],
          identitySignature:
            "d671f8c4eb630d59be0d68c4e3bd35f4639ada4e966f248a11271800a3ae1aeb74c74ce97d89c32ed5d67106c90a8349a6931687c1074bbc5cad69efa3e0e431",
          index: "0".repeat(64),
          files: { "index.html": "0".repeat(64) },
          bundleSignature: "",
        }),
      ),
    ).toBe("21f8867c780e288526e0943f54f83699f1ee9ce71f94024a0e1dae7baa8350f1");
  });

  it("parses exact HTML metadata and preserves data-src/reference locations", () => {
    const value = metadata();
    const html = `<!doctype html><html><head>${metadataHtml(value)}</head><body>ok</body></html>`;
    expect(extractAppMetadata(html)).toEqual(value);
    const referencesHtml = '<img data-src="keep" src=a.png><img src="b.png">';
    const resolved: string[] = [];
    expect(
      replaceHtmlReferences(
        referencesHtml,
        new Map([
          ["a.png", "A"],
          ["b.png", "B"],
        ]),
        (reference) => {
          resolved.push(reference);
          return reference;
        },
      ),
    ).toBe('<img data-src="keep" src=A><img src="B">');
    expect(resolved).toEqual(["a.png", "b.png"]);
  });

  it("signs and verifies an equivalent bundle payload", async () => {
    const value = metadata({ id: "demo-app", name: "Demo 应用" });
    const manifest = {
      ...value,
      identitySignature: identitySignature(value),
      index: "0".repeat(64),
      files: { "index.html": "0".repeat(64) },
      bundleSignature: "",
    } as const;
    const digest = bytesToHex(bundleSigningDigest(manifest));
    expect(digest).toHaveLength(64);
    expect(bundleSigningDigest({ ...manifest, files: { "index.html": "0".repeat(64) } })).toEqual(
      bundleSigningDigest(manifest),
    );
    const signed = await signBundleManifest(signer(), manifest);
    expect(verifyBundleSignature(signed)).toBe(true);
    expect(verifyBundleSignature({ ...signed, app: { ...signed.app, name: "changed" }, identitySignature: identitySignature({ ...value, app: { ...value.app, name: "changed" } }) })).toBe(
      false,
    );
  });

  it("reports path, CSS and dependency graph failures deterministically", () => {
    expect(() => validateLogicalPath("../escape.js")).toThrowError(KeymasterError);
    expect(() => validateLogicalPath(".keymaster.json")).toThrowError(KeymasterError);
    expect(() => validateLogicalPath("keymaster.app.json")).toThrowError(KeymasterError);
    expect(
      extractCssReferences(
        '/* url("./ignored.svg") */ .x { background: url("./image.svg#mask"); content: "url(./fake.svg)"; }',
      ),
    ).toEqual(["./image.svg#mask"]);
    expect(
      replaceCssReferences(
        ".icon { mask: url(icon.svg#mask); }",
        new Map([["icon.svg", "HASH"]]),
        (reference) => reference.split("#", 1)[0]!,
      ),
    ).toBe(".icon { mask: url(HASH#mask); }");
    const graph = createBundleGraph(
      new Map([
        ["assets/a.js", ["assets/b.js"]],
        ["assets/b.js", ["assets/a.js"]],
      ]),
    );
    expect(() => stableDependencyOrder(graph)).toThrowError(/bundle dependency cycle/);
  });

  it("writes and verifies a signed content-addressed deployment", async () => {
    const value = metadata();
    const index = new TextEncoder().encode(
      `<!doctype html><html><head>${metadataHtml(value)}</head><body>ok</body></html>`,
    );
    const css = new TextEncoder().encode("body { color: red; }");
    const hashed = await hashBundleFiles([
      { logicalPath: "index.html", bytes: index },
      { logicalPath: "assets/style.css", bytes: css },
    ]);
    const unsigned = {
      ...value,
      identitySignature: identitySignature(value),
      index: hashed.logicalToHash["index.html"]!,
      files: hashed.logicalToHash,
      bundleSignature: "",
    };
    const signed = await signBundleManifest(signer(), unsigned);
    const parent = await mkdtemp(join(tmpdir(), "keymaster-app-pack-"));
    const directory = join(parent, "dist");
    await writeHashedBundle(directory, hashed, signed);
    const record = await verifyDeployment(directory);
    expect(record.indexHash).toBe(signed.index);
    expect(record.filesByHash[signed.index]!.logicalPaths).toEqual(["index.html"]);
    await expect(readFile(join(directory, "keymaster.app.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(
      join(directory, signed.index),
      Buffer.concat([await readFile(join(directory, signed.index)), Buffer.from("x")]),
    );
    await expect(verifyDeployment(directory)).rejects.toMatchObject({
      code: ERROR_CODES.SEED_HASH_MISMATCH,
    });
  });

  it("rejects undeclared app metadata files and manifest metadata tampering", async () => {
    const { root, manifest } = await unsignedDeployment();
    await writeFile(
      join(root, "keymaster.app.json"),
      JSON.stringify({ ...metadata(), app: { ...metadata().app, name: "changed" } }),
    );
    await expect(verifyDeployment(root)).rejects.toMatchObject({ code: ERROR_CODES.UNDECLARED_FILE });

    const second = await unsignedDeployment();
    await writeFile(
      join(second.root, ".keymaster.json"),
      JSON.stringify({ ...manifest, app: { ...manifest.app, name: "changed" }, identitySignature: identitySignature({ ...metadata(), app: { ...metadata().app, name: "changed" } }) }),
    );
    await expect(verifyDeployment(second.root)).rejects.toMatchObject({
      code: ERROR_CODES.BUNDLE_SIGNATURE_INVALID,
    });
  });

  it("reports a bundle signature error for a signature-only manifest tamper", async () => {
    const { root, manifest } = await unsignedDeployment();
    await writeFile(
      join(root, ".keymaster.json"),
      JSON.stringify({ ...manifest, bundleSignature: "0".repeat(128) }),
    );
    await expect(verifyDeployment(root)).rejects.toMatchObject({
      code: ERROR_CODES.BUNDLE_SIGNATURE_INVALID,
    });
  });

  it("rejects a content hash shared by incompatible MIME types", async () => {
    const value = metadata({ id: "mime-test", name: "MIME Test" });
    const index = new TextEncoder().encode(
      `<html><head>${metadataHtml(value)}</head><body>test</body></html>`,
    );
    const hashed = await hashBundleFiles([{ logicalPath: "index.html", bytes: index }]);
    const manifest = await signBundleManifest(signer(), {
      ...value,
      identitySignature: identitySignature(value),
      index: hashed.logicalToHash["index.html"]!,
      files: { ...hashed.logicalToHash, "assets/same.js": hashed.logicalToHash["index.html"]! },
      bundleSignature: "",
    });
    const parent = await mkdtemp(join(tmpdir(), "keymaster-mime-"));
    const directory = join(parent, "dist");
    await writeHashedBundle(directory, hashed, manifest);
    await expect(verifyDeployment(directory)).rejects.toMatchObject({
      code: ERROR_CODES.MIME_CONFLICT,
    });
  });

  it("rejects an index hash without a unique HTML logical entry", async () => {
    const value = metadata({ id: "entry-test", name: "Entry Test" });
    const html = new TextEncoder().encode(
      `<html><head>${metadataHtml(value)}</head><body>test</body></html>`,
    );
    const hashed = await hashBundleFiles([{ logicalPath: "main.js", bytes: html }]);
    const manifest = await signBundleManifest(signer(), {
      ...value,
      identitySignature: identitySignature(value),
      index: hashed.logicalToHash["main.js"]!,
      files: hashed.logicalToHash,
      bundleSignature: "",
    });
    const parent = await mkdtemp(join(tmpdir(), "keymaster-entry-"));
    const directory = join(parent, "dist");
    await writeHashedBundle(directory, hashed, manifest);
    await expect(verifyDeployment(directory)).rejects.toMatchObject({
      code: ERROR_CODES.ENTRY_MISSING,
    });

    const duplicate = await hashBundleFiles([
      { logicalPath: "index.html", bytes: html },
      { logicalPath: "other.html", bytes: html },
    ]);
    const duplicateManifest = await signBundleManifest(signer(), {
      ...value,
      identitySignature: identitySignature(value),
      index: duplicate.logicalToHash["index.html"]!,
      files: duplicate.logicalToHash,
      bundleSignature: "",
    });
    const duplicateRoot = await mkdtemp(join(tmpdir(), "keymaster-entry-duplicate-"));
    await writeHashedBundle(duplicateRoot, duplicate, duplicateManifest);
    await expect(verifyDeployment(duplicateRoot)).rejects.toMatchObject({
      code: ERROR_CODES.ENTRY_MISSING,
    });
  });

  it("rejects HTML metadata that differs from self-consistent manifest metadata", async () => {
    const value = metadata({ id: "manifest-app", name: "Manifest App" });
    const embedded = metadata({ id: "embedded-app", name: "Embedded App" });
    const files = [
      {
        logicalPath: "index.html",
        bytes: new TextEncoder().encode(
          `<html><head>${metadataHtml(embedded)}</head><body>test</body></html>`,
        ),
      },
    ];
    const hashed = await hashBundleFiles(files);
    const manifest = await signBundleManifest(signer(), {
      ...value,
      identitySignature: identitySignature(value),
      index: hashed.logicalToHash["index.html"]!,
      files: hashed.logicalToHash,
      bundleSignature: "",
    });
    const root = await mkdtemp(join(tmpdir(), "keymaster-metadata-embed-"));
    await writeHashedBundle(root, hashed, manifest);
    await expect(verifyDeployment(root)).rejects.toMatchObject({
      code: ERROR_CODES.METADATA_EMBED_MISMATCH,
    });
  });


  it("rejects an invalid signer public key and keeps a large MasterSeed input streaming-compatible", async () => {
    const value = metadata();
    const manifest = {
      ...value,
      identitySignature: identitySignature(value),
      index: "0".repeat(64),
      files: { "index.html": "0".repeat(64) },
      bundleSignature: "",
    } as const;
    await expect(
      signBundleManifest(signer(new Uint8Array(32).fill(2)), manifest),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PUBLISHER_KEY_MISMATCH,
    });
    const bytes = new Uint8Array(524_289);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    await expect(seedHashBytes(bytes)).resolves.toBe(
      "a83e7842174087df22aab0d1584e1aab014d385083bdacbdff4e9388235bc452",
    );
  });

  it("validates metadata exact fields and requirement ordering", () => {
    const value = metadata();
    expect(() => extractAppMetadata("<meta name=keymaster-app:id content=x>")).toThrow();
    expect(() =>
      validateAppMetadata({ ...value, app: { ...value.app, description: " " } }),
    ).toThrow();
    expect(() => validateAppMetadata({ ...value, app: { ...value.app, name: " name" } })).toThrow();
    expect(() =>
      validateAppMetadata({ ...value, publisherPublicKey: "02" + "00".repeat(32) }),
    ).toThrow();
    expect(() => validateAppMetadata({ ...value, requirements: ["storage", "storage"] })).toThrow();
    expect(() =>
      validateAppMetadata({ ...value, requirements: ["storage", "private-key"] }),
    ).toThrow();
    expect(() =>
      validateAppMetadata({ ...value, requirements: ["unknown"] as never }),
    ).toThrowError(/unknown app requirement/);
    expect(() =>
      extractAppMetadata(`${metadataHtml(value)}<meta name="keymaster-app:id" content="other">`),
    ).toThrow();
    expect(() =>
      extractAppMetadata(metadataHtml({ ...value, app: { ...value.app, name: " " } })),
    ).toThrow();
    expect(() =>
      extractAppMetadata(`${metadataHtml(value)}<meta name="keymaster-app:unknown" content="x">`),
    ).toThrow();
  });
});
