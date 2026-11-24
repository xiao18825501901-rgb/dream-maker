# Claude 只读 Go 转发增量

将 [claude.patch](claude.patch) 应用到已审 v5-cli-responses 有效源码。补丁涉及网关签发、请求体与响应校验，共 5 个 Go 文件。外层选择器仍决定选择哪个协议，Go 按签发的账户、模型及协议发送到同一条 capability 的端点。两条协议分别保留原生 JSON 和原生 SSE。补丁在现有代码内增加 Claude 分支，Pi 路由由主会话合并。

## 重建和回归

先把本目录的四个输入文件复制到有足够空间的新工作目录，再从该目录使用 Windows Node、Git 和冻结的 Go 1.26.8 执行。第二行使用本次构建打印的目录名。开发机上经验证的输入与收据保存在 [E 盘证据目录](<E:/DreamMakerSuite/custom-mvp/parallel/claude-magpie-go/>)。

```powershell
node reproduce.mjs
node process-test.mjs .\build-x5RzXt\build.json
```

[reproduce.mjs](reproduce.mjs) 从 F 盘读取冻结 source、v5 manifest/overlay、已审 Responses 补丁、工具链与离线模块 ZIP。Go 的模块解包、构建缓存、临时文件、测试数据均位于本目录。构建器先重建并核验已审 EXE，然后应用 Claude 增量。针对原测试硬编码的 F 盘保护路径，仅在独立测试 overlay 中重定位测试根检查。生产 overlay 独立。dmbridge 全包及 gateway、provider、access、控制命令的 TestDM/TestDreamMaker 回归通过。

| 输入或产物 | SHA-256 |
| --- | --- |
| 已审基线及重建 | 78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6 |
| Claude 补丁 | 8bbfbb5058dc5b8f10ee61e8ed496c6b30f978a1269296a18c810696dbc23771 |
| 生产候选，两次独立构建一致 | 8b5915181c111afd0958b192df66b2d80d1e113330a7638f3ea48250771d77d2 |
| 仅供正向测试的证书镜像 | a5f416849be8a8f32154a1483e5995e7bfbb12d29b93d75316e3bd679889281f |

## 物理证据

[process-test.mjs](process-test.mjs) 启动真实 EXE，走标准输入控制协议、回环 HTTP 网关、只接受指定合成主机的本地 CONNECT 代理和 TLS 上游。测试逐项验证连接计数、原生请求或握手失败、重放和账本，并核对收到的密钥对应确切账户。runtime 是网关准入字段。本次未启动 Claude CLI，未访问外部模型，付费调用为零，外部资格为 NOT_VERIFIED。

| 镜像与结果 | 用例 | 物理观察 |
| --- | ---: | --- |
| 已审基线 | 4 | 两角色 × 两协议均拒签，零连接 |
| 生产候选使用系统证书根 | 4 | 4 次 CONNECT、4 次拒绝夹具证书、零上游 HTTP；网关返回 502 |
| 独立证书镜像成功 | 4 | Planner2/Reviewer × Chat/Responses，4 次回环 TLS POST；Chat JSON 及 Responses 九帧、原文、账户、模型、协议端点及账本均核实 |
| 独立证书镜像发送前拒绝 | 44 | 签发 24、预留替换 2、入口 18；均为零连接 |
| 独立证书镜像上游回包拒绝 | 23 | 23 条实际 HTTP 回包被拒绝，网关返回 502；覆盖错模型、工具、缓存缺失/矛盾/写入、超过输入/输出限额和不一致的 SSE |

共 79 项。已进入网关的请求重放均返回 403。合并所需输入仅为 [claude.patch](claude.patch)、[reproduce.mjs](reproduce.mjs) 和 [process-test.mjs](process-test.mjs)。

[首次最终构建收据](<E:/DreamMakerSuite/custom-mvp/parallel/claude-magpie-go/build-x5RzXt/build.json>) · [重复构建收据](<E:/DreamMakerSuite/custom-mvp/parallel/claude-magpie-go/build-xw9XYM/build.json>) · [逐例物理收据](<E:/DreamMakerSuite/custom-mvp/parallel/claude-magpie-go/build-x5RzXt/process-U5m0bh/results.json>)
