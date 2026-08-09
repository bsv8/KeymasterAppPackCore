import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { verifyDeployment } from "@keymaster-app-pack/core";
import { keymasterVite } from "../src/index.js";

const identity = {
  version: 1 as const,
  publisherPublicKey: "0284bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0",
  app: { id: "vite-fixture", name: "Vite Fixture" },
  signature:
    "6b4f0ff133164bdbeba45981b0fb31bc94093b67b47f3dc28cf3b55b1105f26033068b93b5829240b12e6d0bd4ef061b7ff49faa1845a8c81887dc92f2c16fcf",
};

describe("Vite adapter", () => {
  it("emits only MasterSeed-named files and an unsigned manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "keymaster-vite-"));
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
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
      plugins: [keymasterVite({ identity })],
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
      '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
    );
    await writeFile(join(root, "src/main.js"), "document.body.dataset.ready = 'yes';\n");
    await build({
      root,
      configFile: false,
      plugins: [keymasterVite({ identity, includeSourceMaps: true })],
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
      '<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>',
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
        plugins: [keymasterVite({ identity, replaceExisting: true }), failingPlugin],
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
      '<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>',
    );
    await writeFile(join(root, "main.js"), "document.body.dataset.ready = 'yes';");
    await expect(
      build({
        root,
        configFile: false,
        plugins: [keymasterVite({ identity })],
        build: { outDir: "dist", sourcemap: false },
      }),
    ).rejects.toThrow("target exists");
    await expect(readFile(join(directory, "old-release.txt"), "utf8")).resolves.toBe("keep-me");
    expect((await readdir(root)).some((name) => name.startsWith("dist.tmp-"))).toBe(false);
    await build({
      root,
      configFile: false,
      plugins: [keymasterVite({ identity, replaceExisting: true })],
      build: { outDir: "dist", sourcemap: false },
    });
    await expect(readFile(join(directory, "old-release.txt"), "utf8")).rejects.toThrow();
    await expect(verifyDeployment(directory, { allowUnsigned: true })).resolves.toBeTruthy();
  });

  it("keeps the previous output when later write or close hooks fail", async () => {
    for (const hook of ["writeBundle", "closeBundle"] as const) {
      const root = await mkdtemp(join(tmpdir(), `keymaster-vite-${hook}-`));
      const directory = join(root, "dist");
      await mkdir(directory);
      await writeFile(join(directory, "old-release.txt"), "keep-me");
      await writeFile(
        join(root, "index.html"),
        '<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>',
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
          plugins: [keymasterVite({ identity, replaceExisting: true }), failingPlugin],
          build: { outDir: "dist", sourcemap: false },
        }),
      ).rejects.toThrow(`intentional ${hook} failure`);
      await expect(readFile(join(directory, "old-release.txt"), "utf8")).resolves.toBe("keep-me");
      expect((await readdir(root)).some((name) => name.startsWith("dist.tmp-"))).toBe(false);
    }
  });
});
