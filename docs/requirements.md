# Keymaster App Pack Core 需求文档

## 1. 文档信息

- 产品：Keymaster App Pack Core
- 仓库：`KeymasterAppPackCore`
- 状态：需求已确认，可进入实现
- 依赖格式：Keymaster Seed V1（由 `masterseed` 提供）
- 首个构建器适配：Vite

本文定义内容寻址 App 包、开发者身份签名、Vite 构建适配、命令行签名和部署验证的产品范围。具体格式见[设计文档](./design.md)，任务拆分见[施工单](./implementation-plan.md)。

## 2. 背景

普通 Vite 项目通常输出：

```text
dist/index.html
dist/assets/style.css
dist/assets/app.js
```

Keymaster App 部署产物要求所有公开文件使用其 MasterSeed Seed Hash 作为文件名：

```text
dist/[indexSeedHash]
dist/[cssSeedHash]
dist/[jsSeedHash]
dist/[imageSeedHash]
dist/.keymaster.json
```

`.keymaster.json` 是构建和部署交接文件。部署服务验证成功并把入口、逻辑路径、媒体类型和 Hash 映射导入自己的部署记录后，可以从公开目录删除该文件。

App 的稳定身份是：

```text
publisherPublicKey + app.id
```

身份不绑定部署 origin。同一份经过开发者签名的 App 可以由任何部署者镜像部署。

## 3. 术语

| 术语                   | 定义                                                  |
| ---------------------- | ----------------------------------------------------- |
| Publisher              | App 开发者；持有 secp256k1 Publisher 私钥             |
| App Identity           | `publisherPublicKey + app.id + app.name` 及其身份签名 |
| Identity Proof         | 可嵌入入口文件、可公开传播的 App Identity 与签名      |
| Bundle                 | 一次构建产生的入口文件和全部静态资源                  |
| Logical Path           | Vite 输出阶段的逻辑文件路径，例如 `assets/app.js`     |
| Seed Hash              | 按 MasterSeed Seed V1 计算的 64 字符小写 hex          |
| Content-addressed File | 文件名等于该文件最终字节的 Seed Hash 的文件           |
| Bundle Manifest        | 最终 `.keymaster.json`                                |
| Deployment Record      | 部署服务验证 Manifest 后持久化的入口和 MIME 映射      |

## 4. 已确认决策

1. 所有 App 文件与 `.keymaster.json` 放在同一个 `dist` 目录。
2. 除 `.keymaster.json` 外，部署文件名统一为文件最终字节的 MasterSeed Seed Hash，不保留扩展名。
3. `.keymaster.json` 使用字典结构；`files` 是 `logicalPath -> seedHash` 子字典。
4. `.keymaster.json` 必须有顶层 `index`，明确 `/` 应映射到哪个 Hash 文件。
5. App Identity 和完整 Bundle 使用两层签名，避免入口文件嵌入完整 Manifest 所造成的循环 Hash。
6. 入口文件只嵌入 Identity Proof；完整文件表和 Bundle 签名只存在于 `.keymaster.json`。
7. Identity Proof 由 App 运行时通过 Keymaster Connect 传给 Keymaster；Keymaster 不依赖部署后的 `.keymaster.json`。
8. Manifest 不包含 origin 和权限列表。部署是去中心化的，权限在本阶段统一开放。
9. Publisher 私钥不得进入 App 仓库、Vite 配置、浏览器代码、`dist` 或 `.keymaster.json`。
10. MasterSeed SDK 保持通用，不增加 Manifest、签名、Vite 或部署业务。
11. 产品由通用 Core、薄 Vite 插件、CLI/Signer 和部署验证库组成，不采用仅靠正则解析 `dist` 的通用 post-build 脚本。

## 5. 产品目标

- 对相同输入字节和配置产生确定性的内容寻址输出。
- 使用 MasterSeed Seed V1 Hash 作为最终文件名。
- 自动重写 HTML、CSS、ES Module 与 Vite emitted asset 的内部引用。
- 最后计算入口文件 Hash，并写入 `.keymaster.json.index`。
- 生成并验证 App Identity 签名和 Bundle 签名。
- 支持本地 Keychain、加密私钥文件、硬件/远程签名器和 CI Signer。
- 部署服务无需依赖 Vite即可验证最终目录。
- 为 S3Disk 等现有 Vite App 提供低侵入接入方式。

## 6. 非目标

- 不修改 MasterSeed Seed V1 算法、块大小或二进制格式。
- 不负责托管 App、选择部署服务器或同步部署节点。
- 不把 Publisher 私钥部署到浏览器。
- 不把 origin 作为 App 身份字段。
- 不定义 Keymaster Connect 或 S3 Storage API；这些属于 `keymaster.cc`。
- V1 不解决任意运行时字符串拼接资源地址。
- V1 不通过反复 Hash 寻找循环 chunk 的固定点。
- V1 不保证外部 HTTPS 资源的完整性。

## 7. 功能需求

### FR-001 App Identity

工具必须支持创建和验证公开的 Identity Proof：

```ts
interface AppIdentityProofV1 {
  version: 1;
  publisherPublicKey: string;
  app: {
    id: string;
    name: string;
  };
  signature: string;
}
```

- `publisherPublicKey` 是 33-byte compressed secp256k1 公钥的小写 hex。
- `app.id` 是 Publisher 命名空间内稳定且唯一的目录标识。
- `app.name` 是受签名保护的展示名称。
- `signature` 是 compact `r || s` 的 64-byte 小写 hex。
- 签名正文使用 JCS 和固定域 `keymaster-app-identity:v1`。

### FR-002 Identity 嵌入

Vite 插件必须在入口 HTML 的构建前阶段嵌入 Identity Proof。推荐形式：

```html
<meta name="keymaster-app-identity" content="[base64url(JCS(identityProof))]" />
```

部署验证器必须能在不执行 HTML/JavaScript 的前提下提取它。App 运行时必须能读取相同内容并交给 Keymaster Connect。

### FR-003 内容寻址命名

每个最终公开文件必须：

1. 在所有内部引用完成替换后计算 MasterSeed Seed Hash；
2. 以 64 字符小写 Seed Hash 作为最终文件名；
3. 保持输出字节与计算 Hash 时的字节逐字节一致；
4. 不因操作系统路径、mtime 或原始文件名改变 Hash。

相同内容可以去重：多个逻辑路径允许指向同一个 Seed Hash。

### FR-004 引用重写

V1 必须支持：

- HTML `src` / `href`；
- CSS `url()` / `@import`；
- ES Module 静态 import；
- ES Module dynamic import；
- Rollup `referencedFiles`；
- Vite 输出的图片、字体、JSON、WASM 等叶子资源。

引用必须使用相对 URL，使 Bundle 可部署在任意路径前缀下。

### FR-005 依赖图与顺序

插件必须从 Vite/Rollup Bundle 元数据建立文件级依赖图，并按反向拓扑顺序处理：

```text
图片/字体/数据 -> CSS/叶子 chunk -> 上层 JS chunk -> index.html
```

遇到文件级循环依赖必须稳定失败并给出环路，不得用不确定迭代掩盖问题。构建器能够合并的循环模块应先合并为单个 chunk。

### FR-006 Bundle Manifest

最终 Manifest 必须满足：

```ts
interface KeymasterAppManifestV1 {
  version: 1;
  publisherPublicKey: string;
  app: { id: string; name: string };
  identitySignature: string;
  index: string;
  files: Record<string, string>;
  bundleSignature: string;
}
```

约束：

- `files` key 是规范逻辑路径，value 是 Seed Hash。
- `index` 必须是 `files` 中某个入口逻辑路径的 value。
- `index.html` 为入口时必须满足 `index === files["index.html"]`。
- `.keymaster.json` 不放入 `files`，避免自引用。
- Bundle 签名覆盖除 `bundleSignature` 外全部字段。

### FR-007 签名器隔离

Core 只接收最小签名能力：

```ts
interface PublisherSigner {
  getPublicKey(): Promise<string>;
  signDigest(digest32: Uint8Array): Promise<Uint8Array>;
}
```

任何公开 API 都不得要求返回或传递 Publisher 私钥字节。Vite 插件不得读取私钥；Bundle 签名由构建后的 CLI/Signer 阶段完成。

### FR-008 部署验证

验证器必须：

1. 严格解析 JSON并拒绝重复字段；
2. 验证字段、路径、Hash 和签名格式；
3. 验证 Identity 签名；
4. 验证 Bundle 签名；
5. 重算每个部署文件的 Seed Hash；
6. 检查 Hash 文件存在且文件名匹配内容；
7. 提取入口中的 Identity Proof，与 Manifest 身份字段做 JCS 全等比较；
8. 输出部署服务需要的入口和媒体类型映射。

### FR-009 CLI

CLI 至少提供：

```text
keymaster-app identity sign
keymaster-app bundle sign
keymaster-app verify <dist>
keymaster-app build
```

所有写入使用临时文件和原子替换。默认不把私钥放入命令行参数或日志。

### FR-010 Vite 接入

S3Disk 一类项目应只需：

- 安装 Vite 插件与 CLI；
- 提供公开的 `keymaster.identity.json`；
- 在 Vite config 注册插件；
- 将发布脚本改为 `keymaster-app build` 或等价组合。

## 8. 非功能需求

### NFR-001 确定性

Manifest JCS 字节、签名 digest、文件 Seed Hash 和最终输出必须可重复。时间、绝对路径、Git 分支、随机数不得进入规范签名正文。

### NFR-002 安全

- 私钥不得进入 Bundle、日志和错误对象。
- Hash、签名和公钥比较使用严格长度与编码检查。
- 路径不得包含绝对路径、反斜杠、空段、`.`、`..`、NUL 或控制字符。
- HTML Identity 提取不得执行脚本。
- 外部资源默认警告，严格模式下拒绝。

### NFR-003 大文件

Seed Hash 计算必须流式进行，内存保持在 `O(MasterSeed BLOCK_SIZE)`；Vite 已在内存中的 chunk 可直接走内存适配，但验证器不得强制整包载入内存。

### NFR-004 可诊断性

错误必须有稳定 code，至少覆盖：无效身份、签名失败、非法路径、引用缺失、依赖循环、Hash 不匹配、入口缺失、Signer 不可用和原子写失败。

### NFR-005 可移植性

Core 与 Verifier 不依赖 Vite。未来新增 Rollup/Webpack 适配器时不得改变 Manifest 和签名格式。

## 9. 验收标准

1. S3Disk 的 Vite 示例能从普通 `dist` 生成全 Hash 文件名产物。
2. 最终目录除 `.keymaster.json` 外没有原始逻辑文件名。
3. `/` 可通过 Manifest `index` 准确映射入口。
4. HTML、CSS、JS、图片引用在部署目录中全部可解析。
5. 修改任意发布文件字节会使 Seed Hash 验证失败。
6. 修改 App ID、名称、Publisher 公钥或 Identity 签名会被拒绝。
7. 修改 `files` 或 `index` 会使 Bundle 签名失败。
8. 入口内 Identity 与 Manifest 不一致时部署验证失败。
9. 文件级循环依赖以稳定错误失败并报告环路。
10. Publisher 私钥不出现在项目、产物、进程参数快照或测试日志中。
11. 相同输入在不同机器上产生相同 Hash、Manifest 签名正文和文件映射。

## 10. 信任边界

Identity Proof 是公开数据，任何部署者都能复制。Keymaster验证它只能证明 Publisher 签署了该 App Identity；实际运行文件是否与签名 Bundle 一致由部署服务验证，使用者选择信任部署者。这一边界是去中心化镜像部署模型的明确前提。
