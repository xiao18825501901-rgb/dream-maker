# ssl.com 代码签名证书：你做什么，我做什么

> 生成于 2026-11-27。本机工具链已全部就绪，**只缺 CA 签发的那一张证书和四项凭据**。
> 下面标「你」的步骤只有你本人能完成（要付钱、要交身份证件、要登录你的账号）。
> 标「已就绪」的是这台机器上已经做完并实测过的。

---

## 现在的真实状态

```
CodeSignTool v1.3.2        OK   D:\DreamMakerSuite\tools\CodeSignTool
  jar                      jar\code_sign_tool-1.3.2.jar  (34 MB)
  Java                     openjdk 25.0.1 已装
signtool                   10.0.22621.0 x64 已装
时间戳服务                 微软可达；digicert / ts.ssl.com / sectigo 在此机为 502
待签目标                   dream-maker.exe  4,024,320 bytes  sha256 567f9bb7e1fccc91
当前签名状态               NotSigned（有意的，见 signing/README_CN.md 第一节）
真证书                     WAIT 等 ssl.com 签发
四项 eSigner 凭据          WAIT 等签发后填
```

---

## 你 | 第 1 步：购买时那个必须勾的框

这一步**买错了要重买**，所以放最前面。

结账页找这个勾选框：

```
Enable certificate issuance for remote signing, team sharing, and presign malware scanning
```

**必须勾上。** 不勾的后果：

- 不会生成 Credential ID
- eSigner 凭据根本不存在
- **证书签发后无法补勾，只能重新买一张**

产品选 **Code Signing Certificate**（不是 SSL/TLS 证书），个人身份选 **IV**。

---

## 你 | 第 2 步：身份验证

| 证书类型 | 要交的材料 |
|---|---|
| 个人 IV | 政府签发身份证件 + 3 个月内地址证明（水电账单/银行对账单）+ 手机号验证 |
| 企业 OV | 上面这些 + 营业执照 + 授权在职证明 |

材料要英文或带翻译件，地址必须和填写的注册地址一致。审核通常 1–3 个工作日。

---

## 你 | 第 3 步：拿四项凭据

签发后登录 ssl.com 控制台：

```
Orders → 找到 Code Signing 订单 → 点 Download
  → 往下滚到 SIGNING CREDENTIALS
      · Credential ID        形如 11111111-2222-3333-4444-555555555555
      · 状态必须是 enabled
  → 同一页找 eSigner PIN / QR 区域
      · 设一个 4 位 PIN
      · 选 "OTP App"，生成二维码
      · 保存页面上给出的 Base32 种子文本
```

**Base32 种子长得像这样**（不是 6 位动态码，是那串长字符串）：

```
JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
```

---

## 已就绪 | 第 4 步：把凭据喂给本机（一条命令）

```powershell
.\signing\Set-eSignerEnv.ps1 -Username <你的登录邮箱> -CredentialId <UUID> -TotpSecret <Base32>
```

密码会交互式提示，不进命令行历史。四项凭据写入 **HKCU 用户环境变量**，不落文件、不进 git、不进便携包。

填完立刻验证（只验账号，**不消耗签名配额**）：

```powershell
.\signing\Set-eSignerEnv.ps1 -Test
```

成功会打印该账号下的 Credential ID 列表 —— 这是"接线通了"最硬的证据。

---

## 已就绪 | 第 5 步：签名

```powershell
.\signing\Sign-WithESigner.ps1 -Sign -UpdateManifest
```

它会：签名 → 打印签名者与时间戳 → 自动重算 `RELEASE_MANIFEST.json`。

---

## 已就绪 | 第 6 步：验收

```powershell
.\signing\Verify-Signature.ps1     # 必须 Status = Valid
.\Verify-Portable.ps1              # 必须仍然 PASS
```

**不需要重新构建 exe。** 签名是对已产出二进制的原地操作。

---

## 我在本机已经做完并实测过的（你不用碰）

| 项 | 证据 |
|---|---|
| 装好 SSL.com 官方 CodeSignTool v1.3.2 | `java -jar code_sign_tool-1.3.2.jar --help` 列出 11 个子命令 |
| 确认签名参数 | `sign -username -password -credential_id -totp_secret -input_file_path -override` |
| 体检脚本改造 | `codesigntool` 从 MISS 变 OK；旧 dlib/metadata 显示 `--` 不需要 |
| 凭据注入脚本 | `Set-eSignerEnv.ps1 -Show` 输出四项状态，`-Test` 可验账号 |
| 时间戳自动探测 | digicert 502 → 自动改用 `timestamp.acs.microsoft.com`，实测签名成功 |
| **签名链路真跑通** | 自签证书 + 微软时间戳：`SignerCN=CN=DreamMaker Suite (self-signed test)`、`TimeStamper=CN=Microsoft Public RSA Time Stamping Authority` |
| 未签名原件已恢复 | `sha256=567f9bb7e1fccc91`、`status=NotSigned` |
| 便携包完整性 | `PASS_CORE_PORTABLE_ONLY files=459` |

**同一套命令只差换证书。** self-signed 那次唯一失败的是根不受信（`terminated in a root certificate which is not trusted`），
那正是真 CA 证书补上的那一块。

---

## 一个必须知道的副作用

签名会改变 `dream-maker.exe` 的字节，所以：

1. **必须先签名，再重算 `RELEASE_MANIFEST.json`** —— 反了会在包校验时报 `PORTABLE_FILE_CHANGED`
2. **签名后 `SIGNING_REQUEST.json` 里记录的 sha256 就过期了** —— 那是"签名前"的基线，正常
3. 签名后的 zip 要重新打包，用户下载到的才是已签名版本

---

## 卡住时先看什么

```powershell
.\signing\Sign-WithESigner.ps1          # 体检，逐项告诉你缺什么
.\signing\Set-eSignerEnv.ps1 -Show      # 只看凭据是否已设置（不打印值）
```

状态词含义：

| 词 | 含义 |
|---|---|
| `OK` | 就绪 |
| `WAIT` | 等 CA 签发，不是你操作错了 |
| `--` | 当前路径不需要这一项 |
| `MISS` | 真缺，要处理 |