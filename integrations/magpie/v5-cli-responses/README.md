# DreamFlow 只读 CLI 的 Responses 增量

本候选在冻结 v5 源码之上增加 OpenCode 和 Cline 的显式 API-key Responses 路由。签发要求 planner2 或 reviewer 与其角色 ID 匹配，且所选账户的同一条 capability 同时声明目标模型、协议和 HTTPS 端点。仅列出模型及旧式端点的账户在签发阶段即被拦截。控制协议仍为 v5。

入口及物理发送共用既有文本白名单。请求需要 stream=true、store=false、正整数输出上限和有界文本输入。工具定义、工具选择和工具结果均不在白名单内。响应沿用完整原生 SSE 校验和用量登记。仅 response 信封里的模型名投影为对外名称。

## 离线重建

从工作树根目录运行以下 PowerShell 命令。重建器先核验并重建相邻的冻结 v5，再将两个源码修改应用到 F 盘私有证据目录，生成独立候选并运行 Go 回归。可选首个参数为同一固定上游提交的本地 Git 仓库路径。

```powershell
. F:/DreamMakerSuite/Use-DreamMakerEnvironment.ps1
node integrations/magpie/v5-cli-responses/reproduce.mjs
```

| 构建 | Windows amd64 EXE SHA-256 |
| --- | --- |
| 冻结 v5 | 15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8 |
| 此增量 | 78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6 |

## 真实 Go 进程验证

将下列参数替换为本次重建输出 EXE 同目录中的 build.json 绝对路径。进程测试在同一证据树生成隔离配置和 results.json。仓库仅保存源码，构建、账本和证据均写入 F 盘 M07。

```powershell
node integrations/magpie/v5-cli-responses/process-test.mjs <build.json>
```

测试通过控制管道、回环 HTTP 入口及仅连接本地的 CONNECT/TLS 夹具运行。冻结 v5 对四个新增组合拒绝签发。增量 EXE 使用系统信任根，私有测试证书由 TLS 拒绝。成功链路使用仅增加 Go 标准库测试证书的单独镜像，仍校验主机名，并核验真实请求、九帧事件、原文、重放及账本。测试中的 runtime 是网关准入字段。资格保持 NOT_VERIFIED，整个验证不调用付费服务。
