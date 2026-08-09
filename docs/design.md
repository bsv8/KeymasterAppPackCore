# Keymaster App Pack Core 设计文档

## 1. 文档目的

本文定义 Keymaster App Manifest V1、两层签名、内容寻址 Bundle、Vite 适配、CLI/Signer 和部署验证的规范性设计。需求见[需求文档](./requirements.md)，实现顺序见[施工单](./implementation-plan.md)。

## 2. 总体架构

```text
App source + public Identity Proof
                 │
                 ▼
              Vite build
                 │ Rollup OutputBundle
                 ▼
       @keymaster-app-pack/vite
       - 注入 Identity
       - 建依赖图
       - 重写引用
       - MasterSeed Hash 命名
       - 生成 unsigned manifest
                 │
                 ▼
        keymaster-app CLI/Signer
        - 调受控 PublisherSigner
        - 写 bundleSignature
        - 最终 verify
                 │
                 ▼
 dist/[seedHash] + dist/.keymaster.json
                 │
                 ▼
        Deployment Verifier
        - 验签/重算 Hash
        - 导入 index/MIME 映射
```

建议仓库布局：

```text
packages/
  core/          Manifest、JCS、签名正文、路径、依赖图、验证模型
  vite-plugin/   Vite/Rollup adapter
  cli/           build/sign/verify 与 signer adapters
examples/
  vite-react/
docs/
```

包名可在实现前确定；格式字符串与 JSON 字段一旦发布不得随包名变化。

## 3. MasterSeed 依赖

最终文件名使用 MasterSeed Seed V1 的 `seed_hash` 小写 hex，而不是直接对源文件做一次 SHA-256：

```text
block_hash[i] = SHA256(file block i, block size = 524288)
seed_bytes    = block_hash[0] || ... || block_hash[n-1]
seed_hash     = SHA256(seed_bytes)
filename      = lowercaseHex(seed_hash)
```

TypeScript 实现依赖 `masterseed` / `masterseed/node`，不得复制算法。`.seed` 文件不进入 App dist；打包和部署完整验证可在流式计算中临时生成 seed bytes 或直接使用 sink 计算结果。

## 4. 规范编码

### 4.1 Hex

- 公钥：66 字符小写 hex，首字节 `02` 或 `03`。
- Seed Hash：64 字符小写 hex。
- compact signature：128 字符小写 hex，布局 `r || s`。
- 禁止 `0x`、空白、分隔符和大小写混用。

### 4.2 JSON

- 规范化采用 RFC 8785 JCS。
- 解析器必须拒绝重复 member name；不能先用会覆盖重复 key 的普通解析器完成安全校验。
- `files` 在源 JSON 中可任意排序，签名时由 JCS 排序。
- 不执行 Unicode 自动 normalization；签名按 JSON string 的确切 Unicode scalar value。

### 4.3 Domain Separation

```text
identitySigningBytes =
  UTF8("keymaster-app-identity:v1") || 0x00 || UTF8(JCS(identityPayload))

bundleSigningBytes =
  UTF8("keymaster-app-bundle:v1") || 0x00 || UTF8(JCS(bundlePayload))

digest = SHA256(signingBytes)
```

签名算法固定 secp256k1 compact 64-byte；V1 JSON 不重复写 algorithm/format。

## 5. App Identity

### 5.1 Payload

```ts
interface AppIdentityPayloadV1 {
  version: 1;
  publisherPublicKey: string;
  app: {
    id: string;
    name: string;
  };
}

interface AppIdentityProofV1 extends AppIdentityPayloadV1 {
  signature: string;
}
```

`app.id` 规则：

```regex
^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$
```

`app.name`：去除首尾空白后非空，最大 120 Unicode code points，不允许控制字符。

Identity Proof 是公开发布凭证，建议提交到 App 仓库：

```text
keymaster.identity.json
```

修改 `app.id`、`app.name` 或 Publisher Key 必须重新签署身份。`app.id` 或 Publisher Key 改变会改变 Keymaster Storage namespace。

### 5.2 HTML 嵌入

规范载荷：

```text
encodedIdentity = base64url(UTF8(JCS(identityProof)))
```

入口 HTML：

```html
<meta name="keymaster-app-identity" content="encodedIdentity" />
```

必须恰好存在一个该 meta。重复、空值、base64url 非规范或解码后不等于 JCS 的情况均失败。

## 6. Bundle Manifest

```ts
interface KeymasterAppManifestV1 {
  version: 1;
  publisherPublicKey: string;
  app: {
    id: string;
    name: string;
  };
  identitySignature: string;
  index: string;
  files: Record<string, string>;
  bundleSignature: string;
}
```

示例：

```json
{
  "version": 1,
  "publisherPublicKey": "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "app": {
    "id": "s3disk",
    "name": "S3Disk"
  },
  "identitySignature": "0123456789abcdef...",
  "index": "56b3320e...",
  "files": {
    "index.html": "56b3320e...",
    "assets/app.js": "2cf24dba...",
    "assets/style.css": "9f86d081...",
    "favicon.svg": "a665a459..."
  },
  "bundleSignature": "abcdef0123456789..."
}
```

Bundle Payload 是删除 `bundleSignature` 后的完整对象。Identity 字段必须与已验证 Identity Proof 完全相同：

```text
version
publisherPublicKey
app
identitySignature = identityProof.signature
```

## 7. 路径与文件映射

### 7.1 Logical Path

逻辑路径：

- 使用 `/`；
- 相对于 Bundle 根；
- 不以 `/` 开头；
- 不含空段、`.`、`..`、反斜杠、NUL、控制字符；
- 最大总长 1024 字符，单段最大 255 字符；
- `.keymaster.json` 为保留名，不得出现在 `files`。

### 7.2 Physical File

```text
physicalPath = dist + "/" + files[logicalPath]
```

不同 logical path 指向相同 Seed Hash 时，物理文件只写一次。若同一 Hash 对应不同字节，视为内部完整性错误。

### 7.3 MIME

Manifest 保留 logical path 以便部署服务按扩展名推导 Content-Type。验证输出：

```ts
interface DeploymentRecordV1 {
  publisherPublicKey: string;
  appId: string;
  appName: string;
  indexHash: string;
  filesByHash: Record<
    string,
    {
      logicalPaths: string[];
      contentType: string;
    }
  >;
}
```

未知扩展名使用 `application/octet-stream`。入口必须为 `text/html; charset=utf-8`。

## 8. Vite 插件生命周期

### 8.1 Config

插件强制或校验：

- `base` 必须允许生成相对资源引用，推荐 `./`；
- V1 默认 `build.sourcemap = false`；开启 sourcemap 时必须显式选择纳入 Bundle 或拒绝；
- 输出先进入 staging directory，不直接覆盖已发布 dist。

### 8.2 `transformIndexHtml`

读取并验证公开 Identity Proof，注入唯一 meta。此阶段不需要私钥。

### 8.3 `generateBundle`

从 `OutputBundle` 收集：

- `OutputChunk.imports`；
- `OutputChunk.dynamicImports`；
- `OutputChunk.referencedFiles`；
- asset 与 HTML/CSS 内已解析引用。

构建 `logicalPath -> dependencies` 图。引用重写必须依据 Bundle 元数据和格式解析器，不允许对任意源代码做宽泛字符串/正则替换。

### 8.4 反向拓扑处理

对 DAG 进行反向拓扑：

1. 叶子 asset：直接 Hash；
2. CSS：替换已知 asset URL 后 Hash；
3. JS chunk：替换依赖 chunk/asset URL 后 Hash；
4. HTML：替换所有入口引用后 Hash；
5. 生成 `files` 与 `index`。

每步的 Hash 输入必须是最终写盘字节。

### 8.5 循环

若文件级依赖图出现 strongly connected component 且成员多于 1，或单节点自引用：

```text
KEYMASTER_BUNDLE_CYCLE
```

错误必须包含稳定的 logical path 环路。V1 不尝试求密码学固定点。调用方应调整 Rollup chunk 策略，把循环模块合并为同一 chunk；未来可另行定义 import-map 扩展。

### 8.6 原子输出

写入流程：

```text
dist.tmp-[random]/[hash files]
dist.tmp-[random]/.keymaster.json (bundleSignature="")
CLI sign + verify
rename/swap to configured dist
```

失败时清理 staging，不留下看似完整的目标目录。替换已有 dist 的策略必须显式配置，不能默认递归删除未知目录。

## 9. 引用重写

### 9.1 HTML

使用 HTML parser 修改本地 `src` / `href`。保留 fragment；本地 query 默认拒绝，避免同一内容出现多种寻址。外部 `http(s):`、`data:`、`blob:` 不进入 Bundle；默认警告，strict 模式拒绝。

### 9.2 CSS

使用 CSS parser 处理 `url()` 和 `@import`，不得替换注释或普通字符串。资源不存在时失败。

### 9.3 JavaScript

优先使用 Rollup chunk 元数据定位已生成引用，并使用 magic-string 一类位置安全工具修改。静态 import、dynamic import 与 `import.meta.ROLLUP_FILE_URL_*` 产物都必须覆盖。

### 9.4 Index 最后处理

入口 Identity 已先嵌入；所有资源 Hash 确定后才替换 HTML URL并计算 index Hash。因此 Identity Proof 不含 `files/index`，完整 Bundle 签名不嵌回 index，避免循环。

## 10. CLI 与 Signer

### 10.1 命令

```text
keymaster-app identity sign --config keymaster.app.json --key <alias>
keymaster-app bundle sign dist/.keymaster.json --key <alias>
keymaster-app verify dist
keymaster-app build --key <alias> -- <vite args...>
```

`--key` 是公开 alias，不是私钥。禁止 `--private-key`。

### 10.2 Signer Adapter

优先级建议：

1. OS Keychain / hardware signer；
2. 远程 signing service / KMS；
3. 项目目录外的密码加密 key file；
4. CI 临时文件描述符/stdin。

加密 key file 推荐路径：

```text
~/.config/keymaster-publisher/keys/[publisherPublicKey].key
```

文件权限 `0600`。MasterSeed 项目不保存 Publisher key。

### 10.3 Bundle Sign

CLI 必须先验证空签名 Manifest、所有文件 Hash 和 Identity，再调用 signer。签名写入临时 `.keymaster.json.tmp`，落盘同步后原子替换。

## 11. Deployment Verifier

严格顺序：

1. 读取 `.keymaster.json`，限制大小；
2. 拒绝重复 JSON key；
3. 校验 schema 和规范编码；
4. 重建并验证 Identity Proof；
5. 验证 Bundle 签名；
6. 对 `files` 每个唯一 Hash 检查物理文件存在；
7. 流式重算 Seed Hash并比较；
8. 检查没有未声明的公开 Hash 文件（策略可配置，默认 strict）；
9. 读取 index 文件并提取 Identity meta；
10. 比较 index Identity 与 Manifest；
11. 生成 DeploymentRecord；
12. 部署服务持久化 record、设置 `/` internal rewrite 后，才允许删除 `.keymaster.json`。

## 12. 错误模型

建议稳定 code：

```text
IDENTITY_INVALID
IDENTITY_SIGNATURE_INVALID
MANIFEST_INVALID
BUNDLE_SIGNATURE_INVALID
PUBLISHER_KEY_MISMATCH
LOGICAL_PATH_INVALID
ENTRY_MISSING
REFERENCE_MISSING
BUNDLE_CYCLE
SEED_HASH_MISMATCH
UNDECLARED_FILE
IDENTITY_EMBED_MISMATCH
SIGNER_UNAVAILABLE
ATOMIC_WRITE_FAILED
OPERATION_ABORTED
```

自然语言 message 不构成兼容协议。

## 13. S3Disk 参考接入

S3Disk 当前为 Vite + React。首个端到端 fixture 应覆盖：

- `index.html`；
- React JS chunk；
- CSS；
- `favicon.svg`；
- 图片或字体；
- 本地动态 import fixture；
- `base: "./"` 下从任意部署前缀加载。

工具只改构建产物，不改变 S3Disk 当前业务源码。S3Disk 后续从直连 S3 迁移到 Keymaster Storage API 属于 `keymaster.cc` 与 S3Disk 的另一阶段。
