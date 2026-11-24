# DreamFlow Custom v5 Magpie 源码包

在 F 盘 Dream Maker 项目终端运行以下命令。可选参数是含固定提交的本地 Git 仓库路径。

```powershell
. F:/DreamMakerSuite/Use-DreamMakerEnvironment.ps1
node integrations/magpie/v5/reproduce.mjs
```

构建入口从本地 Git 对象检出提交 `1aca55909ff94f5c23091ce35f73cb4b7bc46658`，在新的 M07 证据目录中恢复 20 个基线文件，校验完整 Git 状态、模块清单、Go 1.26.8 Windows amd64 工具摘要和 21 项 overlay，再用项目已有的离线模块缓存编译。所有源码映射均相对本目录，清单用同一份内容满足字节相同的基线和 overlay 条目。每次构建在证据目录写入 EXE 和摘要收据。

预期 EXE SHA-256 为 `15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8`。独立重建收据位于 `F:/DreamMakerSuite/evidence/M07/v5-source-rebuild-5HLd0T/receipt.json`。

三协议进程对照收据位于 `F:/DreamMakerSuite/evidence/M07/v5-process-tls-IK4Qpj/result.json`。生产 EXE 使用 Windows 系统信任根，TLS 拒绝私有夹具证书。仅测试镜像通过进程内公开测试根完成本地 HTTPS 正向响应。该镜像的附加源文件位于外部证据构建目录，未纳入本包。外部服务资格为 `NOT_VERIFIED`，付费调用次数为零。
