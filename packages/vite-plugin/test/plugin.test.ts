import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { verifyDeployment } from "@keymaster-app-pack/core";
import { keymasterVite } from "../src/index.js";

const metadataHtml =
  '<meta name="keymaster-app:id" content="vite-fixture"><meta name="keymaster-app:publisher-public-key" content="0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"><meta name="keymaster-app:name" content="Vite Fixture"><meta name="keymaster-app:description" content="Fixture"><meta name="keymaster-app:requirement" content="storage"><meta name="keymaster-app:identity-signature" content="217a8c1761de074dc3c1e6e90f31f00b09f54ecb87d9ba2b1e157570033777c4373fc0281c76466ab20d04bc231b61a52ae3681c08e11f021ae6955718c1cb17">';

describe("Vite adapter", () => {
  it("emits only MasterSeed-named files and an unsigned manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-vite-"));
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><html><head>${metadataHtml}</head><body><script type="module" src="/src/main.js"></script></body></html>`,
    );
    await writeFile(
      join(root, "src/main.js"),
      'import "./style.css"; document.body.dataset.ready = "yes"; import("./lazy.js");',
    );
    await writeFile(join(root, "src/lazy.js"), "export const ready = true;");
    await writeFile(join(root, "src/style.css"), "body { color: #123; }");
    await build({
      root,
      configFile: false,
      plugins: [keymasterVite()],
      build: { outDir: "dist", sourcemap: false },
    });
    const record = await verifyDeployment(join(root, "dist"), { allowUnsigned: true });
    expect(record.appId).toBe("vite-fixture");
    const files = await readFile(join(root, "dist", ".keymaster.json"), "utf8");
    expect(files).toContain('"bundleSignature":""');
  });

  it("rewrites included source map URLs to their content hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-vite-sourcemap-"));
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><html><head>${metadataHtml}</head><body><script type="module" src="/src/main.js"></script></body></html>`,
    );
    await writeFile(join(root, "src/main.js"), "document.body.dataset.ready = 'yes';\n");
    await build({
      root,
      configFile: false,
      plugins: [keymasterVite({ includeSourceMaps: true })],
      build: { outDir: "dist", sourcemap: true },
    });
    const directory = join(root, "dist");
    await expect(verifyDeployment(directory, { allowUnsigned: true })).resolves.toBeTruthy();
    const manifest = JSON.parse(await readFile(join(directory, ".keymaster.json"), "utf8")) as {
      files: Record<string, string>;
    };
    const mapLogicalPath = Object.keys(manifest.files).find((path) => path.endsWith(".map"));
    const scriptLogicalPath = Object.keys(manifest.files).find((path) => path.endsWith(".js"));
    expect(mapLogicalPath).toBeDefined();
    expect(scriptLogicalPath).toBeDefined();
    const mapHash = manifest.files[mapLogicalPath!]!;
    const script = await readFile(join(directory, manifest.files[scriptLogicalPath!]!), "utf8");
    expect(script).toContain(`sourceMappingURL=../${mapHash}`);
  });

  it("leaves the previous direct Vite output when a later bundle hook fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-vite-atomic-"));
    const directory = join(root, "dist");
    await mkdir(directory);
    await writeFile(join(directory, "old-release.txt"), "keep-me");
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><html><head>${metadataHtml}</head><body><script type="module" src="/main.js"></script></body></html>`,
    );
    await writeFile(join(root, "main.js"), "document.body.dataset.ready = 'yes';");
    const failingPlugin = {
      name: "fail-after-keymaster",
      enforce: "post" as const,
      generateBundle() {
        throw new Error("intentional late bundle failure");
      },
    };
    await expect(
      build({
        root,
        configFile: false,
        plugins: [keymasterVite({ replaceExisting: true }), failingPlugin],
        build: { outDir: "dist", sourcemap: false },
      }),
    ).rejects.toThrow("intentional late bundle failure");
    await expect(readFile(join(directory, "old-release.txt"), "utf8")).resolves.toBe("keep-me");
    expect((await readdir(root)).some((name) => name.startsWith("dist.tmp-"))).toBe(false);
  });

  it("requires explicit authorization before replacing an existing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-vite-replace-"));
    const directory = join(root, "dist");
    await mkdir(directory);
    await writeFile(join(directory, "old-release.txt"), "keep-me");
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><html><head>${metadataHtml}</head><body><script type="module" src="/main.js"></script></body></html>`,
    );
    await writeFile(join(root, "main.js"), "document.body.dataset.ready = 'yes';");
    await expect(
      build({
        root,
        configFile: false,
        plugins: [keymasterVite()],
        build: { outDir: "dist", sourcemap: false },
      }),
    ).rejects.toThrow("target exists");
    await expect(readFile(join(directory, "old-release.txt"), "utf8")).resolves.toBe("keep-me");
    expect((await readdir(root)).some((name) => name.startsWith("dist.tmp-"))).toBe(false);
    await build({
      root,
      configFile: false,
      plugins: [keymasterVite({ replaceExisting: true })],
      build: { outDir: "dist", sourcemap: false },
    });
    await expect(readFile(join(directory, "old-release.txt"), "utf8")).rejects.toThrow();
    await expect(verifyDeployment(directory, { allowUnsigned: true })).resolves.toBeTruthy();
  });

  it("rejects reserved manifest names copied from publicDir", async () => {
    for (const reserved of [".keymaster.json", "keymaster.app.json"]) {
      const root = await mkdtemp(
        join(tmpdir(), `keymaster-vite-public-${reserved.replaceAll(".", "-")}-`),
      );
      await mkdir(join(root, "public"));
      await writeFile(join(root, "public", reserved), "pre-existing");
      await writeFile(
        join(root, "index.html"),
        `<!doctype html><html><head>${metadataHtml}</head><body><script type="module" src="/main.js"></script></body></html>`,
      );
      await writeFile(join(root, "main.js"), "document.body.dataset.ready = 'yes';");
      await expect(
        build({
          root,
          configFile: false,
          plugins: [
            {
              name: "pre-existing-reserved-input",
              generateBundle() {
                this.emitFile({ type: "asset", fileName: reserved, source: "pre-existing" });
              },
            },
            keymasterVite(),
          ],
          build: { outDir: "dist", sourcemap: false },
        }),
      ).rejects.toThrow("reserved output file");
    }
  });

  it("keeps the previous output when later write or close hooks fail", async () => {
    for (const hook of ["writeBundle", "closeBundle"] as const) {
      const root = await mkdtemp(join(tmpdir(), `keymaster-vite-${hook}-`));
      const directory = join(root, "dist");
      await mkdir(directory);
      await writeFile(join(directory, "old-release.txt"), "keep-me");
      await writeFile(
        join(root, "index.html"),
        `<!doctype html><html><head>${metadataHtml}</head><body><script type="module" src="/main.js"></script></body></html>`,
      );
      await writeFile(join(root, "main.js"), "document.body.dataset.ready = 'yes';");
      const failingPlugin =
        hook === "writeBundle"
          ? {
              name: `fail-${hook}`,
              enforce: "post" as const,
              writeBundle() {
                throw new Error(`intentional ${hook} failure`);
              },
            }
          : {
              name: `fail-${hook}`,
              enforce: "post" as const,
              closeBundle: {
                order: "post" as const,
                handler() {
                  throw new Error(`intentional ${hook} failure`);
                },
              },
            };
      await expect(
        build({
          root,
          configFile: false,
          plugins: [keymasterVite({ replaceExisting: true }), failingPlugin],
          build: { outDir: "dist", sourcemap: false },
        }),
      ).rejects.toThrow(`intentional ${hook} failure`);
      await expect(readFile(join(directory, "old-release.txt"), "utf8")).resolves.toBe("keep-me");
      expect((await readdir(root)).some((name) => name.startsWith("dist.tmp-"))).toBe(false);
    }
  });
});
