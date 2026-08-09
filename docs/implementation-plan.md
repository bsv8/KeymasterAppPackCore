# Keymaster App Pack Core 施工单

## 1. 施工目标

在空仓库中建立可发布的 TypeScript workspace，完成 Core、Vite 插件、CLI/Signer、部署验证器和 S3Disk 风格 fixture。施工必须按阶段合入，任何阶段不得把 Publisher 私钥放入测试仓库或构建产物。

## 2. 推荐里程碑

```text
M1 格式与 Core
M2 Identity 与 Signer
M3 Vite 内容寻址插件
M4 CLI 与原子构建
M5 Deployment Verifier
M6 S3Disk 验收与发布
```

## 3. 工单 APPPACK-001：工程骨架

### 工作

- 建立 pnpm workspace。
- 新建 `packages/core`、`packages/vite-plugin`、`packages/cli`。
- 配置 TypeScript project references、Vitest、ESLint/格式化和构建导出。
- 引入 `masterseed` / `masterseed/node`，禁止复制 Seed V1 算法。
- 配置 CI：typecheck、unit、integration、package smoke。

### 验收

- 三包可独立 build/test。
- Core 不依赖 Vite；Vite plugin 和 CLI 单向依赖 Core。
- 空 fixture 可在 Linux/macOS 路径语义下运行。

## 4. 工单 APPPACK-002：规范数据与严格 JSON/JCS

### 工作

- 实现 Manifest/Identity TypeScript 类型与 runtime validator。
- 实现严格 JSON parser 或接入能拒绝重复 key 的库。
- 实现 RFC 8785 JCS。
- 实现 public key、signature、Seed Hash、app id/name、logical path 校验。
- 建立跨实现黄金向量：JCS bytes、domain-separated digest。

### 测试

- 重复 key、非法 surrogate、非规范数字、大小写 hex、`0x`、路径穿越。
- `files` 原始顺序不同但 JCS 与 digest 相同。
- App 名 Unicode 的确切字节保持稳定。

## 5. 工单 APPPACK-003：Identity 签名与嵌入

### 工作

- 实现 `buildIdentitySigningBytes/digest`。
- 实现 secp256k1 compact sign/verify adapter。
- 实现 Identity Proof base64url/JCS codec。
- 实现 HTML meta 注入和不执行脚本的提取器。
- 实现 `keymaster-app identity sign`，只接受 signer alias/provider。

### 验收

- 修改任意 Identity 字段验签失败。
- 一个入口只能有一个 Identity meta。
- Identity 文件可安全提交，扫描不含私钥。

## 6. 工单 APPPACK-004：MasterSeed 文件寻址层

### 工作

- 封装内存 bytes 与 Node file path 的 Seed Hash API。
- 实现 staging writer、内容去重、Hash filename 冲突检查。
- 返回 `logicalPath -> seedHash` 与唯一物理文件集合。
- 支持 AbortSignal 和流式大文件。

### 验收

- 与 MasterSeed 官方黄金向量一致。
- 大于 512 KiB 文件不是简单 SHA-256 文件名。
- 修改最终字节必然改变文件名。
- 相同内容只写一个物理文件。

## 7. 工单 APPPACK-005：Vite Bundle 图

### 工作

- 从 Rollup OutputBundle 建立节点和引用边。
- 覆盖 imports、dynamicImports、referencedFiles、HTML/CSS 资源。
- 实现稳定拓扑排序与 SCC/cycle 报告。
- 定义 external URL、data/blob URL 和 query/fragment 策略。

### 验收

- DAG 顺序固定。
- 循环 fixture 返回 `BUNDLE_CYCLE` 和完整环路。
- 缺失引用返回 `REFERENCE_MISSING`，不静默保留。

## 8. 工单 APPPACK-006：格式化重写器

### 工作

- HTML parser adapter。
- CSS parser adapter。
- ES Module/Rollup generated-reference adapter。
- 资源 URL 保持相对路径。
- 明确 sourcemap V1 策略并加入门禁。

### 验收

- 不修改注释和普通字符串中的伪 URL。
- static/dynamic import 都可加载。
- CSS `url()`、`@import` 和 HTML src/href 全覆盖。
- 不支持的动态路径以稳定错误失败。

## 9. 工单 APPPACK-007：Vite 插件编排

### 工作

- 实现 `transformIndexHtml` Identity 注入。
- 实现 `generateBundle` 图处理和输出重命名。
- index 最后 Hash。
- 生成 `bundleSignature: ""` 的 unsigned Manifest。
- 支持 configurable entry logical path，默认 `index.html`。
- staging 输出，不破坏已有 dist。

### 验收

- 最终 Hash 文件内容与文件名逐一匹配。
- Manifest `index === files[entry]`。
- 最终目录没有旧 Vite 文件名和未声明文件。

## 10. 工单 APPPACK-008：Bundle Signer 与 CLI

### 工作

- 实现 Bundle signing bytes/digest/verify。
- 实现 signer provider registry。
- 首批 adapter：测试内存 signer、加密文件 signer；OS Keychain/远程 signer 可按平台拆后续工单。
- 实现 `bundle sign`、`verify`、`build`。
- 禁止私钥命令行参数；日志脱敏。

### 验收

- Sign 前完整验证文件和 Identity。
- Manifest 原子替换。
- 模拟 signer 失败时 unsigned staging 不会发布为最终 dist。
- 日志/错误/argv 快照不含私钥。

## 11. 工单 APPPACK-009：Deployment Verifier

### 工作

- 实现目录级严格验证。
- 流式重算所有 Seed Hash。
- 验证 index 内 Identity 一致。
- 输出 DeploymentRecord 和 MIME map。
- 提供 Node API 与 CLI JSON 输出。

### 验收

- 文件缺失、篡改、多余文件、错误 MIME 推导、入口错配均失败。
- DeploymentRecord 足以让服务器在删除 Manifest 后服务 `/` 和 Hash 文件。

## 12. 工单 APPPACK-010：S3Disk 风格集成 fixture

### 工作

- 建 Vite + React 示例，不直接修改 S3Disk。
- 覆盖 HTML、单/多 chunk JS、CSS、SVG、图片、动态 import。
- 生成真实 MasterSeed Hash 目录。
- 用静态测试 server 根据 DeploymentRecord 完成 `/` internal rewrite。
- 浏览器 smoke 验证从非根部署前缀启动。

### 验收

- 页面可渲染、CSS/图片加载、dynamic import 成功。
- 所有网络内本地资源 URL 都是 Seed Hash 文件。
- `.keymaster.json` 删除后，依赖 DeploymentRecord 仍可正常服务。

## 13. 工单 APPPACK-011：安全与发布收口

### 工作

- 恶意 JSON/path/HTML fixture。
- 私钥泄漏扫描。
- 文档 CLI/API。
- semver、package exports、npm provenance/签名发布策略。
- 固化 Manifest V1 黄金向量；发布后任何字节规则改变必须升协议版本。

### 完成定义

- 需求文档全部验收标准通过。
- `npm pack` 内容检查通过。
- Core/Vite/CLI/Verifier 公共 API 有文档和示例。
- S3Disk 风格 fixture 端到端通过。
- 无真实 Publisher 私钥进入仓库或 CI artifact。

## 14. 不在本施工单

- 修改 S3Disk 使用 Keymaster Storage API。
- 修改 Keymaster Connect。
- 实现部署平台自身。
- 支持循环 chunk 的 import-map 扩展。
- 支持 Webpack/Rollup 独立 adapter。
