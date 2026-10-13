# Keymaster App Pack 实施计划

## 当前硬切换

旧的 `keymaster.identity.json`、`keymaster-app identity sign` 和 Vite 自动注入
Identity 的流程已取消，不提供兼容壳。App Identity Proof 保留，但唯一来源改为
发行人手工维护的 HTML meta；CLI 只负责签名输出和 proof JSON 派生。

当前实施顺序：

- Publisher CLI：使用 `KEYMASTER_PUBLISHER_KEY_DIR` 管理 `<name>.publisher.key`，提供
  `publisher create/list`，并让 bundle sign/build 通过 `--key <name>` 共享目录 signer；

1. 从源码或构建后的入口 HTML 严格读取 App metadata；
2. 由 `keymaster-app app sign --publisher <name>` 输出 identity signature，发行人手工写入入口 HTML 后，`app create` 在项目根生成完整 flat proof `keymaster.app.json`；
3. Vite/writer 从已签名 HTML 生成同时携带 `identitySignature` 与独立
   `bundleSignature` 的部署 `.keymaster.json`；
4. 在签名前后验证 HTML、Manifest 与内容寻址文件；
5. 通过 staging 原子发布；
6. 由发行人把项目根 `keymaster.app.json` 人工导入 Keymaster 本地 catalog，部署目录不携带它。

## 完成条件

- Core、CLI、Vite adapter 使用同一 `AppMetadataV1` 与 `AppIdentityProofV1`
  validator；
- Vite 不再接受 Identity 配置或注入 meta；
- CLI 的 `app sign` 只输出签名和可粘贴 meta，不修改 HTML；
- 两个 JSON 保留名不能被 App 资源占用，部署目录仅允许 `.keymaster.json`；
- Bundle signer 公钥必须等于 HTML meta 公钥；
- 回归测试覆盖 metadata、签名、篡改、内容寻址、MIME、入口唯一性和原子发布；
- README、需求、设计和 API 文档只描述当前流程。
