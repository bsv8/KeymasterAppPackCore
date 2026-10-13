# Keymaster App Pack 需求

## 1. 产物

一次成功部署构建必须输出：

```text
dist/
  [seedHash]
  [seedHash]
  ...
  .keymaster.json
```

项目根目录另有 `keymaster.app.json`，它由 `keymaster-app app create` 从
`index.html` 生成，用于 metadata 导入；不是 build、dist 或 deployment 文件。
部署目录除 `.keymaster.json` 外不得出现该文件。

## 2. App metadata

- 源码入口 HTML meta 是唯一手写真值；
- 必填字段为 app id、Publisher 公钥、name、description；
- requirement 为零个或多个 `private-key`、`storage`；
- requirement 必须排序、唯一，未知值失败；
- App id 必须稳定且适合作为 namespace；
- Publisher 公钥必须是有效 compressed secp256k1 小写 hex；
- `app sign --publisher <name>` 必须签署完整 metadata，只输出 signature/meta，
  不修改 HTML 或 JSON；
- 构建和 `app create` 都必须要求 HTML 含唯一且有效的 identity signature；
- `keymaster.app.json` 必须从入口 meta 与 identity signature 派生为 flat proof；CLI 默认读取
  cwd/index.html，默认拒绝覆盖已有输出，`--replace` 才允许原子替换。

## 3. Manifest 与签名

- `.keymaster.json` 必须包含完整 App metadata、`identitySignature`、`index`、
  `files` 和 `bundleSignature`；
- `identitySignature` 必须验证完整 metadata payload；
- Bundle 签名必须覆盖除自身外的完整 Manifest；
- signer 公钥必须与 HTML 声明一致；
- 私钥不得进入 App 源码、HTML、构建产物、Manifest 或命令行参数。

## 4. 内容寻址与引用

- 必须稳定处理 HTML、CSS、静态 ESM、动态 ESM 和 Rollup 引用；
- 本地引用必须解析到 bundle 内文件并改写为最终 Hash；
- 未支持的动态路径、缺失引用、依赖环或同 Hash MIME 冲突必须失败；
- `.keymaster.json` 与 `keymaster.app.json` 均为保留逻辑路径；
- Manifest 不得把保留文件纳入 `files`，部署目录只允许 `.keymaster.json` 控制文件。

## 5. 验证

生产验证必须检查：

- JSON 使用严格解析，拒绝重复 member；
- Manifest 和 App metadata exact keys；
- HTML、App JSON 与 Manifest 中的 Identity proof signature；
- Bundle signature；
- 文件集合、类型、Hash 和入口唯一性；
- HTML 与 Manifest metadata 全等；部署目录出现 App JSON 按未声明文件失败；
- 文件系统符号链接和未声明文件。

任一失败都不得生成成功 Deployment Record。

## 6. 原子性与失败策略

- 已有输出目录默认不得覆盖；
- 显式替换也必须保留到新构建完全成功；
- build、bundle、write 或 close hook 失败必须保留旧产物并清理 staging；
- 不增加自动重试、半成品发布或复杂恢复状态机；失败后允许完整重新执行。

## 7. CLI 与 signer

- CLI 只接受 signer alias，不接受私钥参数；
- signer provider 可由硬件、系统 keystore 或加密文件实现；
- 内置文件 provider 使用显式的 `KEYMASTER_PUBLISHER_KEY_DIR` 和
  `KEYMASTER_PUBLISHER_KEY_PASSWORD`；`publisher create <name>` 生成随机 secp256k1
  密钥并保存为 `<name>.publisher.key`，`publisher list` 无需密码并按 name 排序输出公开部分；
- `--key <name>`、create 和 list 均拒绝非法 name、路径穿越、symlink、同名覆盖及损坏文件；
- Bundle 签名前必须完整验证 unsigned 产物；
- 签名后必须再次按生产规则验包。

## 8. 验收

- 类型检查、Core/CLI/Vite 单测、示例构建全部通过；
- meta 缺失、重复、未知、乱序或非法公钥构建失败；
- signer 不匹配失败；
- HTML、Manifest、文件内容或 Bundle 签名篡改失败；
- Vite 输入占用保留文件名失败；
- 原子替换与晚期 hook 失败不会破坏旧发布目录。
