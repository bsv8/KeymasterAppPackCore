# 公共 API 与发布流程

## Core

`@keymaster-app-pack/core` 提供：

- `jcs`、`parseStrictJson`：RFC 8785 风格规范 JSON 和拒绝重复 key 的解析；
- `signIdentityProof`、`verifyIdentityProof`、`encodeIdentityProof`、`decodeIdentityProof`；
- `bundleSigningDigest`、`signBundleManifest`、`verifyBundleSignature`；
- `seedHashBytes`、`seedHashFile`、`hashBundleFiles`；
- `verifyDeployment`：验证目录并返回 `DeploymentRecordV1`；
- `createBundleGraph`、`stableDependencyOrder`：稳定依赖顺序和循环报告；
- `injectIdentityMeta`、`extractIdentityProof`：不执行脚本的入口 Identity 处理。

Core 只接受 `PublisherSigner` 的公开能力：

```ts
interface PublisherSigner {
  getPublicKey(): Promise<string>;
  signDigest(digest32: Uint8Array): Promise<Uint8Array>;
}
```

## Vite

```ts
import keymasterVite from "@keymaster-app-pack/vite-plugin";
import identity from "./keymaster.identity.json" with { type: "json" };

export default { plugins: [keymasterVite({ identity })] };
```

插件在 `transformIndexHtml` 注入 Identity，在 `generateBundle` 根据 Rollup/Rolldown 图处理 HTML、CSS、静态和动态 ESM 引用，并通过 `emitFile` 输出内容寻址文件。

`generateBundle` 只生成 `bundleSignature: ""` 的 unsigned Manifest；签名必须在构建后由 CLI/Signer 完成。

插件默认把产物写入目标目录旁的随机 staging 目录，并将最终化 hook 追加到已解析的用户插件队列末端；其他插件的 `writeBundle`/`closeBundle` 失败时也会清理 staging。已有目标目录必须显式设置 `replaceExisting: true` 才允许替换。`atomicOutput: false` 可关闭插件 staging。正式发布仍应使用 CLI 的外层 staging 完成签名和最终回滚；直接 Vite 构建仅作为 unsigned 中间产物。启用 `build.sourcemap` 时必须同时设置 `includeSourceMaps: true`，插件会将 `sourceMappingURL` 改写为对应 Seed Hash 的相对 URL。

## CLI

```text
keymaster-app identity sign --config keymaster.identity.json --key publisher
keymaster-app bundle sign dist/.keymaster.json --key publisher
keymaster-app verify dist
keymaster-app build --key publisher -- --outDir dist --replace
```

`build` 先写入同级随机 staging 目录，完成 unsigned 验证、签名和 signed 验证后再发布。替换已有目录必须显式传 `--replace`；签名失败时旧目录保持不变。

默认 signer provider 从项目外的加密 key 文件读取：

```text
KEYMASTER_PUBLISHER_KEY_FILE=/secure/path/publisher.key
KEYMASTER_PUBLISHER_KEY_PASSWORD=...
```

## Deployment verifier

```ts
const record = await verifyDeployment("dist");
```

验证器默认要求 Bundle 签名、严格文件集合、所有物理文件 Seed Hash、入口 Identity 与 Manifest 全部匹配。构建中间状态可显式使用 `{ allowUnsigned: true }`，不应把该选项用于生产入口。
