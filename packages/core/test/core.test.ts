import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  ERROR_CODES,
  KeymasterError,
  bundleSigningDigest,
  decodeIdentityProof,
  encodeIdentityProof,
  extractCssReferences,
  createBundleGraph,
  hashBundleFiles,
  injectIdentityMeta,
  identitySigningDigest,
  jcs,
  parseStrictJson,
  replaceCssReferences,
  replaceHtmlReferences,
  seedHashBytes,
  signBundleManifest,
  signIdentityProof,
  stableDependencyOrder,
  bytesToHex,
  validateLogicalPath,
  verifyDeployment,
  verifyIdentityProof,
  writeHashedBundle,
} from "../src/index.js";
import type { AppIdentityPayloadV1, PublisherSigner } from "../src/index.js";

const privateKey = secp256k1.utils.randomSecretKey();

function signer(): PublisherSigner {
  return {
    async getPublicKey() {
      return Buffer.from(secp256k1.getPublicKey(privateKey, true)).toString("hex");
    },
    async signDigest(digest) {
      return secp256k1.sign(digest, privateKey, { lowS: true, prehash: false });
    },
  };
}

describe("Keymaster App Pack core", () => {
  it("canonicalizes objects and rejects duplicate keys", () => {
    expect(jcs({ files: { b: 2, a: 1 }, app: "你好" })).toBe(
      '{"app":"你好","files":{"a":1,"b":2}}',
    );
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrowError(KeymasterError);
    expect(() => parseStrictJson('{"a":"\\ud800"}')).toThrowError(KeymasterError);
    expect(
      bytesToHex(
        identitySigningDigest({
          version: 1,
          publisherPublicKey: "0284bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0",
          app: { id: "fixture", name: "Fixture" },
        }),
      ),
    ).toBe("383e5c563e8df27758a38c6956c7ff651259682e127fb1b18093834bb34ffd0c");
    const zeroHash = "0".repeat(64);
    expect(
      bytesToHex(
        bundleSigningDigest({
          version: 1,
          publisherPublicKey: "0284bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0",
          app: { id: "fixture", name: "Fixture" },
          identitySignature:
            "6b4f0ff133164bdbeba45981b0fb31bc94093b67b47f3dc28cf3b55b1105f26033068b93b5829240b12e6d0bd4ef061b7ff49faa1845a8c81887dc92f2c16fcf",
          index: zeroHash,
          files: { "index.html": zeroHash },
          bundleSignature: "",
        }),
      ),
    ).toBe("295977caa68bad3d3d63855dea7feb49c545e8db93ad7a31c0e5dff4b61195e8");
  });

  it("matches the JCS golden vector and preserves reference locations", () => {
    expect(
      jcs({
        z: "€$𐍈",
        a: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27],
        m: { false: false, null: null, true: true },
      }),
    ).toBe(
      '{"a":[333333333.3333333,1e+30,4.5,0.002,1e-27],"m":{"false":false,"null":null,"true":true},"z":"€$𐍈"}',
    );
    const html = '<img data-src="keep" src=a.png><img src="b.png">';
    const resolved: string[] = [];
    expect(
      replaceHtmlReferences(
        html,
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
    expect(
      replaceCssReferences(
        ".icon { mask: url(icon.svg#mask); }",
        new Map([["icon.svg", "HASH"]]),
        (reference) => reference.split("#", 1)[0]!,
      ),
    ).toBe(".icon { mask: url(HASH#mask); }");
  });

  it("signs, encodes, verifies and detects identity mutation", async () => {
    const payload: Omit<AppIdentityPayloadV1, "publisherPublicKey"> = {
      version: 1,
      app: { id: "demo-app", name: "Demo 应用" },
    };
    const proof = await signIdentityProof(signer(), payload);
    expect(verifyIdentityProof(proof)).toBe(true);
    expect(decodeIdentityProof(encodeIdentityProof(proof))).toEqual(proof);
    expect(verifyIdentityProof({ ...proof, app: { ...proof.app, name: "changed" } })).toBe(false);
  });

  it("reports path, CSS and dependency graph failures deterministically", () => {
    expect(() => validateLogicalPath("../escape.js")).toThrowError(KeymasterError);
    expect(
      extractCssReferences(
        '/* url("./ignored.svg") */ .x { background: url("./image.svg"); content: "url(./fake.svg)"; }',
      ),
    ).toEqual(["./image.svg"]);
    const graph = createBundleGraph(
      new Map([
        ["assets/a.js", ["assets/b.js"]],
        ["assets/b.js", ["assets/a.js"]],
      ]),
    );
    expect(() => stableDependencyOrder(graph)).toThrowError(/bundle dependency cycle/);
  });

  it("writes and verifies a signed content-addressed deployment", async () => {
    const proof = await signIdentityProof(signer(), {
      version: 1,
      app: { id: "fixture", name: "Fixture" },
    });
    const index = new TextEncoder().encode(
      injectIdentityMeta("<!doctype html><html><head></head><body>ok</body></html>", proof),
    );
    const css = new TextEncoder().encode("body { color: red; }");
    const hashed = await hashBundleFiles([
      { logicalPath: "index.html", bytes: index },
      { logicalPath: "assets/style.css", bytes: css },
    ]);
    const unsigned = {
      version: 1 as const,
      publisherPublicKey: proof.publisherPublicKey,
      app: proof.app,
      identitySignature: proof.signature,
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
    await writeFile(
      join(directory, signed.index),
      Buffer.concat([await readFile(join(directory, signed.index)), Buffer.from("x")]),
    );
    await expect(verifyDeployment(directory)).rejects.toMatchObject({
      code: ERROR_CODES.SEED_HASH_MISMATCH,
    });
  });

  it("rejects a content hash shared by incompatible MIME types", async () => {
    const proof = await signIdentityProof(signer(), {
      version: 1,
      app: { id: "mime-test", name: "MIME Test" },
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
      files: { ...hashed.logicalToHash, "assets/same.js": hashed.logicalToHash["index.html"]! },
      bundleSignature: "",
    };
    const signed = await signBundleManifest(signer(), unsigned);
    const parent = await mkdtemp(join(tmpdir(), "keymaster-mime-"));
    const directory = join(parent, "dist");
    await writeHashedBundle(directory, hashed, signed);
    await expect(verifyDeployment(directory, { allowUnsigned: false })).rejects.toMatchObject({
      code: ERROR_CODES.MIME_CONFLICT,
    });
  });

  it("rejects an index hash without a unique HTML logical entry", async () => {
    const proof = await signIdentityProof(signer(), {
      version: 1,
      app: { id: "entry-test", name: "Entry Test" },
    });
    const html = new TextEncoder().encode(
      injectIdentityMeta("<html><head></head><body>test</body></html>", proof),
    );
    const hashed = await hashBundleFiles([{ logicalPath: "main.js", bytes: html }]);
    const unsigned = {
      version: 1 as const,
      publisherPublicKey: proof.publisherPublicKey,
      app: proof.app,
      identitySignature: proof.signature,
      index: hashed.logicalToHash["main.js"]!,
      files: hashed.logicalToHash,
      bundleSignature: "",
    };
    const signed = await signBundleManifest(signer(), unsigned);
    const parent = await mkdtemp(join(tmpdir(), "keymaster-entry-"));
    const directory = join(parent, "dist");
    await writeHashedBundle(directory, hashed, signed);
    await expect(verifyDeployment(directory)).rejects.toMatchObject({
      code: ERROR_CODES.ENTRY_MISSING,
    });
  });

  it("keeps a large MasterSeed input on the streaming-compatible path", async () => {
    const bytes = new Uint8Array(524_289);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    await expect(seedHashBytes(bytes)).resolves.toBe(
      "a83e7842174087df22aab0d1584e1aab014d385083bdacbdff4e9388235bc452",
    );
  });
});
