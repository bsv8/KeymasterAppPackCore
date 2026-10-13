# KeymasterAppPackCore

Keymaster App 内容寻址打包、签名和部署验证工具。

项目从构建后的 `index.html` 读取 App meta，将普通 Vite 产物转换成以
MasterSeed Seed V1 Hash 命名的不可变文件，并生成部署控制清单：

- `.keymaster.json`：包含 HTML identity proof、文件表和独立 `bundleSignature` 的包清单。

`keymaster.app.json` 是项目根目录的公开 flat identity proof 文件，不是构建或部署文件。
它由 CLI 从项目 `index.html` 生成，绝不会写入 `dist` 或其他部署目录：

```sh
keymaster-app publisher create publisher
# 手工把输出公钥写入 index.html
keymaster-app app sign --publisher publisher
# 手工把输出的 identity-signature meta 写入 index.html
keymaster-app app create
keymaster-app app create --input src/index.html --out keymaster.app.json --replace
```

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

App 必须在源 `index.html` 中声明 `keymaster-app:id`、
`keymaster-app:publisher-public-key`、`keymaster-app:name`、
`keymaster-app:description` 和零个或多个 `keymaster-app:requirement` meta。
执行 `app sign` 后还必须手工写入唯一的 `keymaster-app:identity-signature` meta。
Vite 项目注册 `keymasterVite()` 后会从构建后的入口读取这些字段，生成 `.keymaster.json`
和 Seed Hash 文件；插件不生成项目 `keymaster.app.json`。插件和 Core writer 会拒绝
把 `keymaster.app.json` 当作 bundle 逻辑文件，防止它泄漏到部署目录。

已有 `dist` 时需显式配置 `replaceExisting: true` 才会替换。正式发布应使用 CLI
的外层 staging 流程。
构建阶段只生成 unsigned Manifest；使用 CLI 的 signer alias 完成 Bundle 签名：

```sh
export KEYMASTER_PUBLISHER_KEY_DIR=/secure/keymaster-publishers
export KEYMASTER_PUBLISHER_KEY_PASSWORD='...'
keymaster-app publisher create publisher
keymaster-app publisher list
keymaster-app bundle sign dist/.keymaster.json --key publisher
keymaster-app verify dist
```

先用 `app sign --publisher <name>` 生成 identity signature（命令只输出签名，不改写 HTML）；
再将签名写入唯一 `keymaster-app:identity-signature` meta 后构建。`keymaster.app.json`
保存完整 flat proof，不参与部署验收；`bundleSignature` 负责认证 identity proof、入口和全部构建文件。

Publisher 私钥只从 signer provider 读取。内置加密文件 signer 使用显式的
`KEYMASTER_PUBLISHER_KEY_DIR` 和 `KEYMASTER_PUBLISHER_KEY_PASSWORD`；每个 Publisher
以 `<name>.publisher.key` 文件保存，私钥不会出现在命令行参数、Manifest 或浏览器代码中。

公共 API 说明见 [API 文档](./docs/api.md)。
