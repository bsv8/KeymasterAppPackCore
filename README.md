# KeymasterAppPackCore

Keymaster App 内容寻址打包、签名和部署验证工具。

项目把普通 Vite 产物转换成以 MasterSeed Seed V1 Hash 命名的不可变文件，
生成签名的 `.keymaster.json`，并提供部署验证与入口映射所需数据。

## 文档

- [需求文档](./docs/requirements.md)
- [设计文档](./docs/design.md)
- [施工单](./docs/implementation-plan.md)

当前状态：可运行原型。核心 Happy Path 已通过；APPACK-006/007/008/009/011 的发布门禁仍在完善，尚不承诺 `0.1.0` 正式发布。

## 快速开始

```sh
pnpm install
pnpm build
pnpm test
```

Vite 项目注册 `keymasterVite({ identity })` 后会生成 `.keymaster.json` 和 Seed Hash 文件；已有 `dist` 时需显式配置 `replaceExisting: true` 才会替换。正式发布应使用 CLI 的外层 staging 流程。
构建阶段只生成 unsigned Manifest；使用 CLI 的 signer alias 完成 Bundle 签名：

```sh
keymaster-app bundle sign dist/.keymaster.json --key publisher
keymaster-app verify dist
```

Publisher 私钥只从 signer provider 读取。内置加密文件 signer 使用
`KEYMASTER_PUBLISHER_KEY_FILE` 与 `KEYMASTER_PUBLISHER_KEY_PASSWORD`，私钥不会出现在命令行参数、Manifest 或浏览器代码中。

公共 API 说明见 [API 文档](./docs/api.md)。
