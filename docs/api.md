# Keymaster App Pack API

## Core metadata

`AppMetadataV1` 是从构建后入口 HTML 派生的公开数据：

```ts
interface AppMetadataV1 {
  version: 1;
  publisherPublicKey: string;
  app: {
    id: string;
    name: string;
    description: string;
  };
  requirements: Array<"private-key" | "storage">;
}
```

主要 API：

- `extractAppMetadata(html)`：读取并严格校验唯一的 HTML meta 真值；
- `validateAppMetadata(value)`：校验派生 JSON 或本地导入数据；
- `metadataJson(value)`：输出固定字段的 metadata；
- `identityProofJson(value)`：输出项目根使用的 flat identity proof JSON；
- `extractAppIdentityProof(html)` / `assertIdentityProof(proof)`：要求并校验 HTML 身份签名；
- `metadataFromManifest(manifest)`：从 Bundle Manifest 投影 App metadata。

未知 `keymaster-app:*` meta、重复字段、未知或乱序 requirement、无效 secp256k1
公钥都会失败。

## Vite 插件

```ts
import { defineConfig } from "vite";
import { keymasterVite } from "@keymaster-app-pack/vite-plugin";

export default defineConfig({
  plugins: [keymasterVite()],
});
```

常用选项：

- `entryLogicalPath`：入口逻辑路径，默认 `index.html`；
- `strictExternal`：拒绝未内容寻址的外部引用；
- `includeSourceMaps`：把 source map 纳入内容寻址文件；
- `atomicOutput`：是否使用 staging 目录，默认启用；
- `replaceExisting`：是否允许替换已有输出目录，默认不允许。

插件在 `generateBundle` 阶段读取已经过 Vite 变换和引用重写的入口 HTML，输出
内容寻址文件和 `bundleSignature` 为空的 `.keymaster.json`；其中
`identitySignature` 已从 HTML proof 读取并完成验证。插件不生成
`keymaster.app.json`；输入产物
不得预先包含 `.keymaster.json` 或 `keymaster.app.json` 这两个保留文件名。

## 项目 metadata CLI

`keymaster.app.json` 是项目根文件，不是 build、dist 或 deployment 文件。使用以下
命令从项目 HTML 生成它（默认读取 cwd/index.html，路径相对 cwd 解析）：

```sh
keymaster-app app sign --publisher publisher
keymaster-app app sign --publisher publisher --input src/index.html
keymaster-app app create
keymaster-app app create --input src/index.html --out keymaster.app.json --replace
```

`app sign` 必须指定 publisher alias，只输出 `{publisher,publisherPublicKey,signature,meta}`
机器 JSON（`meta` 是唯一的 `<meta name="keymaster-app:identity-signature" content="...">` 字符串），不写入 HTML。`app create` 要求 HTML 已有有效 signature，默认读取
cwd/index.html、写项目根 `keymaster.app.json`，只接受 `--input`、`--out`、`--replace`；
默认拒绝覆盖，且不读取 signer 环境、不修改 HTML、不会自动创建父目录。

## Bundle Manifest 与签名

`KeymasterAppManifestV1` 在 `AppMetadataV1` 后增加：

```ts
interface KeymasterAppManifestV1 extends AppMetadataV1 {
  identitySignature: string;
  index: string;
  files: Record<string, string>;
  bundleSignature: string;
}
```

主要 API：

- `validateManifest`、`manifestJson`；
- `bundleSigningBytes`、`bundleSigningDigest`；
- `signBundleManifest`、`verifyBundleSignature`；
- `verifyDeployment`、`writeHashedBundle`。

Bundle 签名域为 `keymaster-app-bundle:v1`。签名 payload 是删除
`bundleSignature` 后的完整 Manifest，使用 JCS 编码。`signBundleManifest` 会先检查
signer 公钥等于 metadata 中的 Publisher 公钥。

## CLI

```sh
export KEYMASTER_PUBLISHER_KEY_DIR=/secure/keymaster-publishers
export KEYMASTER_PUBLISHER_KEY_PASSWORD='...'
keymaster-app publisher create publisher
keymaster-app publisher list
keymaster-app bundle sign dist/.keymaster.json --key publisher
keymaster-app verify dist
keymaster-app build --key publisher -- --outDir dist
```

CLI 不接受私钥命令行参数。`publisher create <name>` 生成随机 secp256k1
密钥并保存为目录中的 `<name>.publisher.key`；`publisher list` 只读取公开部分，
不需要密码。内置加密文件 signer 从以下环境变量读取：

```sh
KEYMASTER_PUBLISHER_KEY_DIR=/secure/keymaster-publishers
KEYMASTER_PUBLISHER_KEY_PASSWORD='...'
```

`--key <name>` 在该目录中定位对应 Publisher 文件。目录必须专用并显式提供，文件
采用 0600 权限；create 不覆盖同名文件，list 遇到损坏或未知文件直接失败。

`bundle sign` 会先以 unsigned 模式完整验包，再签名并原子替换 Manifest；
`build` 使用 staging 目录执行 Vite、签名、再次验包，全部成功后才发布输出目录。

## 部署验证

`verifyDeployment(directory)` 默认要求：

1. Bundle 签名有效；
2. 所有物理文件名和内容 Seed Hash 一致；
3. `index` 唯一对应一个 HTML 逻辑入口；
4. HTML meta 与 `.keymaster.json` metadata 完全一致；
5. 没有未声明文件或同一 Hash 的 MIME 冲突（部署目录中的 `keymaster.app.json`
   属于未声明文件）。

`allowUnsigned: true` 只用于构建和签名前的中间状态，不得用于生产验收。
