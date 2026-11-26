# 签名与校验（DreamMaker）

> 本目录只有工具脚本，**不含任何私钥材料**。测试证书在 `D:/DreamMakerSuite/signing-test/`，不随包分发。

## 一、当前状态（2026-11-27 实测）

    dream-maker.exe   4,024,320 bytes   sha256 567f9bb7e1fccc91…
    Authenticode      NotSigned

    CodeSignTool      OK  v1.3.2 (jar 34 MB)  java openjdk 25.0.1
    signtool          OK  10.0.22621.0 x64
    本地真证书         WAIT 等 ssl.com 签发
    四项 eSigner 凭据  WAIT 等签发后填

**未签名是有意的。** 自签名会让状态从 `NotSigned` 变成 `UnknownError`，用户看到的警告并没有变好，
反而更难解释。实测过：自签 + 微软时间戳后，签名者与时间戳都正确，但 `signtool verify /pa` 报
`A certificate chain processed, but terminated in a root certificate which is not trusted`。
**签名本身是对的，缺的只是根不受信 —— 这正是真 CA 证书会补上的那一块。**

## 二、签名路径（按可用性排序）

### A. CodeSignTool（SSL.com 官方 CLI，已装好，首选）

    .\signing\Sign-WithESigner.ps1                    # 体检：告诉你还差什么
    .\signing\Sign-WithESigner.ps1 -Sign -UpdateManifest

体检逐项列出：`codesigntool` / `module` / `esigner dlib` / `metadata` / `store cert` /
四项 `ESIGNER_*` / `target`。状态含义：`OK` 就绪、`WAIT` 等证书、`--` 不需要、`MISS` 真缺。

底层就是：

    java -jar <CodeSignTool>\jar\code_sign_tool-1.3.2.jar sign \
      -username=<邮箱> -password=<密码> \
      -credential_id=<UUID> -totp_secret=<Base32> \
      -input_file_path=dream-maker.exe -override

> **这台机器实测：`ssl.com` 的 jar 自带的 `TSA_URL=http://ts.ssl.com` 在签名时由服务端处理，
> 本地不需要连它。** 只有走 signtool 路径时才需要能连上的时间戳服务（见第四节）。

### B. signtool + 证书存储（真证书装进 Cert:\CurrentUser\My 之后）

    .\signing\Sign-DreamMaker.ps1 -Thumbprint <sha1> -UpdateManifest

### C. eSigner dlib（旧客户端形态，保留兼容）

    $env:ESIGNER_DLIB     = "C:\path\to\esigner.dll"
    $env:ESIGNER_METADATA = "C:\path\to\metadata.json"
    .\signing\Sign-WithESigner.ps1 -Sign -UpdateManifest

### D. PS 模块 `SSLcomCodeSign`

**PSGallery 上没有这个包**（实测 0 条）。脚本保留探测，但不作为可用路径。

## 三、先固定"要签什么"

    .\signing\Prepare-Signing.ps1

产出 `SIGNING_REQUEST.json` + `SIGNING_TARGETS.txt`，把每个待签 PE 的
路径/字节数/sha256/版本固定下来。**证书到手后逐字节核对，签错文件会被发现。**

当前基线：**1 个 PE** —— `dream-maker.exe  4,024,320 bytes  567f9bb7e1fccc91`。

只有 PE 能带 Authenticode 签名；`.ps1` / `.js` 由 `RELEASE_MANIFEST.json` 覆盖。
`runtime/node.exe` 被刻意排除 —— 那是 Node 官方二进制，不该由我们签。

## 四、时间戳服务：这台机器只有微软可达

实测 `Invoke-WebRequest -Method Head` 结果：

| 服务 | 结果 |
|---|---|
| `http://timestamp.acs.microsoft.com` | **HTTP 200** |
| `http://timestamp.digicert.com` | HTTP 502 |
| `http://ts.ssl.com` | HTTP 502 |
| `http://timestamp.sectigo.com` | HTTP 502 |
| `http://time.certum.pl` | HTTP 502 |

`Sign-DreamMaker.ps1` 因此改成**先探测再签**，自动挑第一个可达的；全部不可达时明确警告
"将不盖时间戳（正式发布不要这样）"，而不是静默签出一个无时间戳的文件。

**无时间戳的签名在证书过期后即失效**，所以这一条不能省。

## 五、两个必须记住的顺序坑

1. **签名改字节 → 必须先签名再重算清单。** 反了 `verifyPortableDirectory` 会在
   `dream-maker.exe` 上报 `PORTABLE_FILE_CHANGED`（真踩过）。
2. **pfx/cer 不能放包内。** 放了 `verifyTree` 报 `PORTABLE_EXTRA_FILE`（也踩过）。

## 六、换真证书：六步

### 第 1 步（你本人）购买时必勾 eSigner

结账页有一个勾选框：

    Enable certificate issuance for remote signing, team sharing, and presign malware scanning

**必须勾上。** 不勾的后果是实打实的：不会生成 Credential ID，eSigner 凭据不存在，
**而且证书签发后无法补勾，只能重新买一张。**

### 第 2 步（你本人）身份验证

个人 IV 需要：政府签发身份证件 + 3 个月内地址证明 + 手机号验证。
企业 OV 另加营业执照与在职证明。这一步只能你本人完成。

### 第 3 步（你本人）取四项凭据

    控制台 → Orders → 找到 Code Signing 订单 → Download
      → 滚动到 SIGNING CREDENTIALS
        · Credential ID（UUID 格式）
        · Signing credential status 必须是 enabled
      → 同一页找 eSigner PIN / QR
        · 设 4 位 PIN
        · 选 OTP App，生成二维码
        · **保存 Base32 种子文本**（不是 6 位动态码）

### 第 4 步（本机一条命令）

    .\signing\Set-eSignerEnv.ps1 -Username <邮箱> -CredentialId <UUID> -TotpSecret <Base32>

密码会交互式提示，不进命令行历史。凭据写入**当前用户环境变量**，不落盘到本仓库。

填完立刻验证（只验账号，不消耗签名配额）：

    .\signing\Set-eSignerEnv.ps1 -Test

成功会打印该账号下的 Credential ID 列表 —— 这是"接线通了"最硬的证据。

### 第 5 步（本机一条命令）签名

    .\signing\Sign-WithESigner.ps1 -Sign -UpdateManifest

它会：签名 → 打印签名者与时间戳 → 自动重算 `RELEASE_MANIFEST.json`。

### 第 6 步 验收

    .\signing\Verify-Signature.ps1     # 必须 Status = Valid
    .\Verify-Portable.ps1              # 必须仍然 PASS

**不需要重新构建 exe。** 签名是对已产出二进制的原地操作。

## 七、凭据安全

- 凭据只存 HKCU 用户环境变量，不写文件、不进 git、不进便携包
- 清除：`.\signing\Set-eSignerEnv.ps1 -Clear`
- 查看哪些已设置（不打印值）：`.\signing\Set-eSignerEnv.ps1 -Show`
- **`CodeSignTool/conf/code_sign_tool.properties` 里的 `CLIENT_ID` 是 SSL.com 内置的公共标识，不是你的密钥**；
  你的身份靠用户名 + 密码 + TOTP + Credential ID 四件套