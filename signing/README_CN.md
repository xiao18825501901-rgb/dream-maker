# 签名与校验（DreamMaker）

> 本目录只有工具脚本，**不含任何私钥材料**。测试证书在 `D:/DreamMakerSuite/signing-test/`，不随包分发。

## 一、当前状态（2026-11-26）

    dream-maker.exe   2,704,896 bytes
    Authenticode      NotSigned
    sha256            746648eb…

**这是有意的。** 未签名 + 明确的"未知发布者"提示，比自签名造成的 `UnknownError` 更诚实：
自签名让状态从 `NotSigned` 变成 `UnknownError`，用户看到的警告并没有变好，反而更难解释。

（实测过：自签后 `signtool verify /pa` 报
`A certificate chain processed, but terminated in a root certificate which is not trusted`，
时间戳校验通过，说明签名本身正确，只是根不受信。）

## 二、三条签名路径

### A. eSigner 云签名（推荐，2023 年后唯一能拿到的形态）

    .\signing\Sign-WithESigner.ps1                 # 体检：告诉你还差什么
    .\signing\Sign-WithESigner.ps1 -Sign -UpdateManifest

体检逐项列出：

    module           SSLcomCodeSign 是否可用
    esigner dlib     esigner.dll 路径
    metadata         eSigner 控制台导出的 .json
    store cert       证书存储里有没有真证书
    ESIGNER_*        四项凭据
    target           dream-maker.exe 的哈希

凭据用环境变量传，不要写进脚本：

    $env:ESIGNER_USERNAME      = "..."
    $env:ESIGNER_PASSWORD      = "..."
    $env:ESIGNER_TOTP_SECRET   = "..."    # Base32 种子，不是 6 位码
    $env:ESIGNER_CREDENTIAL_ID = "..."

### B. signtool + eSigner dlib

    $env:ESIGNER_DLIB     = "C:\path\to\esigner.dll"
    $env:ESIGNER_METADATA = "C:\path\to\metadata.json"
    .\signing\Sign-WithESigner.ps1 -Sign -UpdateManifest

脚本内部执行的就是：

    signtool sign /fd SHA256 /tr <ts> /td SHA256 /dlib esigner.dll /dmdf metadata.json dream-maker.exe

### C. 证书已在证书存储（OV 落地后的形态）

    .\signing\Sign-DreamMaker.ps1 -Thumbprint <sha1> -UpdateManifest

## 三、先固定"要签什么"

    .\signing\Prepare-Signing.ps1

产出 `SIGNING_REQUEST.json` + `SIGNING_TARGETS.txt`，把每个待签 PE 的
路径/字节数/sha256/版本固定下来。**证书到手后逐字节核对，签错文件会被发现。**

只有 PE 能带 Authenticode 签名；`.ps1` / `.js` 由 `RELEASE_MANIFEST.json` 覆盖。
`runtime/node.exe` 被刻意排除——那是 Node 官方二进制，不该由我们签。

## 四、两个必须记住的顺序坑

1. **签名改字节 → 必须先签名再重算清单。** 反了 `verifyPortableDirectory` 会在
   `dream-maker.exe` 上报 `PORTABLE_FILE_CHANGED`（真踩过）。
2. **pfx/cer 不能放包内。** 放了 `verifyTree` 报 `PORTABLE_EXTRA_FILE`（也踩过）。

## 五、换真证书的标准流程

1. ssl.com 买 **Code Signing Certificate**（不是 SSL/TLS），个人选 **IV**，优先 **eSigner 云签名**
2. 身份验证（个人：身份证 + 3 个月内地址证明 + 手机号）
3. 证书签发后取 eSigner 凭据（用户名/密码/TOTP 种子/Credential ID）
4. `.\signing\Sign-WithESigner.ps1 -Sign -UpdateManifest`
5. `.\signing\Verify-Signature.ps1` 应输出 `Status = Valid`
6. `.\Verify-Portable.ps1` 应仍然 PASS

**不需要重新构建 exe。** 签名是对已产出二进制的原地操作。
