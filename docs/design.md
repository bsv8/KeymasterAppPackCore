# Keymaster App Pack 设计

## 1. 目标

App Pack 解决两个彼此独立的问题：

1. 把 Web App 构建产物转换成可验证的内容寻址文件；
2. 生成一份便于人工导入 Keymaster 的公开 App metadata。

系统保留两种职责不同的签名：Identity 签名认证稳定 App identity 与 requirements，
Bundle 签名认证一次具体构建。`keymaster.app.json` 包含 Identity proof，但没有额外的
文件外层签名。

## 2. 真值与派生关系

```text
源码/项目 index.html meta ─────► app sign 输出 identity-signature
        │                         │ 发行人手工写回 HTML
        │                         ▼
        ├───────────────────────► 项目根 keymaster.app.json
        │                         flat proof、人工导入 catalog
        │ Vite 构建、引用重写、Hash
        ▼
构建后入口 HTML ───────────────► .keymaster.json
        proof + index + files + bundleSignature
```

源码 `index.html` meta 是唯一手写真值。`keymaster.app.json` 由
`keymaster-app app create` 写在项目根目录，供人工导入；Vite 构建只生成部署所需
的 `.keymaster.json`，禁止把项目 JSON 复制进 `dist`。禁止从 JSON 或 Vite 配置反向
注入 HTML；部署验证器只比较 HTML 与 `.keymaster.json`，不读取项目文件。

## 3. HTML meta

```html
<meta name="keymaster-app:id" content="example-app">
<meta name="keymaster-app:publisher-public-key" content="03...">
<meta name="keymaster-app:name" content="Example App">
<meta name="keymaster-app:description" content="Example description">
<meta name="keymaster-app:requirement" content="private-key">
<meta name="keymaster-app:requirement" content="storage">
<meta name="keymaster-app:identity-signature" content="...">
```

- 四个单值字段必须各出现一次；
- requirement 可出现零次或多次，但必须字典序排列且不得重复；
- V1 只认识 `private-key`、`storage`，未知值失败；
- App id 是稳定 namespace，不使用部署 origin 代替；
- Publisher 公钥必须是有效的 compressed secp256k1 小写 hex。
- identity-signature 必须是 `app sign` 对完整 metadata payload 生成的有效
  64-byte compact secp256k1 签名。

## 4. 派生 App metadata

```json
{
  "version": 1,
  "publisherPublicKey": "03...",
  "app": {
    "id": "example-app",
    "name": "Example App",
    "description": "Example description"
  },
  "requirements": ["private-key", "storage"],
  "signature": "..."
}
```

文件不包含 origin、URL、icon 或 launch；它包含 identity proof signature。部署位置由 Keymaster 自己的
本地 catalog 管理；任意部署者都可以镜像同一 App。

这份 JSON 是项目数据交接格式，也是 HTML 中同一份 `AppIdentityProof` 的 flat JSON
投影。Keymaster 把它人工纳入本地 catalog 后先验签，再用于 requirements 门禁和
Storage namespace；具体部署包的真实性来自独立 Bundle 签名。

## 5. 内容寻址

Vite adapter 根据 Rollup/Rolldown 图稳定处理依赖，从叶节点向入口替换 HTML、
CSS、静态与动态 ESM 引用。每个最终文件使用 MasterSeed Seed V1 Hash 命名；入口
最终 Hash 写入 Manifest `index`。

`.keymaster.json` 是部署控制文件，不进入 `files`，避免自引用；它是部署目录唯一
允许的控制 JSON。`keymaster.app.json` 仅是项目根文件，输入 bundle、publicDir 或
逻辑文件一律不得占用该名称，以免泄漏到部署目录。

## 6. Bundle 签名

Manifest 结构是 App metadata 加 `identitySignature`、`index`、`files`、
`bundleSignature`。
签名字节：

```text
UTF8("keymaster-app-bundle:v1")
  || 0x00
  || UTF8(JCS(manifest without bundleSignature))
```

对字节做 SHA-256，再用 Publisher secp256k1 私钥生成 64-byte compact 签名。
签名覆盖 name、description、requirements、Publisher 公钥、入口和完整文件表。

私钥由 `PublisherSigner` 提供；Core 不读取环境变量，CLI provider 才负责从受控
环境解锁 signer。内置 provider 从显式 `KEYMASTER_PUBLISHER_KEY_DIR` 按
`<name>.publisher.key` 定位文件，并用 `KEYMASTER_PUBLISHER_KEY_PASSWORD` 解密；
signer 返回的公钥必须等于 HTML metadata 公钥。`publisher create <name>` 创建新密钥，
`publisher list` 仅读取并排序公开部分。

## 7. 原子发布

直接 Vite 与 CLI 构建都优先写 staging 目录。只有构建、文件 Hash、metadata
一致性、签名和最终验包全部成功，才把 staging 原子发布为目标目录。已有目录默认
拒绝替换；必须显式授权。晚期 bundle/write/close hook 失败时保留旧目录并清理
staging。

不增加自动重试或部分发布恢复状态机。失败后修正输入并重新运行完整构建，符合系统
“简单失败、可重新执行”的原则。

## 8. 信任边界

- HTML/JSON 是公开信息，不含私钥；
- `keymaster.app.json` 可复制，但复制本身不获得签名能力；
- Bundle 签名认证一个确定构建，不限制谁可以部署相同字节；
- Keymaster 不应从任意运行中网页接受自报 metadata；它只使用本地人工导入数据；
- `private-key` 和 `storage` 是运行前置条件，不是授予 App 的权限。
