# Pi executor 原生协议的 Magpie Go 增量

此目录叠加在已登记的 `78a0` 版本上。构建脚本先将登记构建所用的源树与 21 个覆盖文件复制到独立目录，并重建、校验原始二进制。增量修改准入矩阵、控制器的账号能力检查和 Go 物理转发路径。两个新 Go 文件验证 Pi 工具声明、请求历史和响应事件。

## Wire 合同

- Pi executor 支持 `openai-responses` 和 `anthropic-messages`。控制器为每次 POST 冻结角色、账号、能力端点、协议、模型、预算、请求摘要及单次凭据。物理端点来自选中账号显式声明的能力。
- 已安装 Pi 向本机控制器发送裸模型。控制器把请求体模型绑定为 `provider/Org/Mixed-Name`。Go 核查摘要后向上游发送 `Org/Mixed-Name`。经校验的 Pi SSE 返回相同的上游裸模型，大小写和全部斜杠均保留。历史监督路由沿用自己的模型投影。
- 每轮接受单个文本或单个已声明工具调用。覆盖 `desk_read`、`desk_search`、`desk_write`、`desk_edit`、`desk_run` 的固定参数形状。业务工具执行及路径授权由 broker 负责。本套件实际执行的工具为 `desk_read`。
- 工具调用、结果及下一轮应答要通过 ID 与结构检查。控制器拥有跨轮预算和历史完整性。客户端只在 Go 收齐并校验 SSE 后获得输出。物理尝试和成功释放分别记录。

## Windows 离线复现

在工作树根目录的 PowerShell 运行。使用已有固定 Go、模块缓存、Node 和 Pi CLI。将 `$isolated` 指向已建立的本次授权 E 盘独立目录。

```powershell
$kit = 'integrations/magpie/v5-pi-native'
$registered = 'F:/DreamMakerSuite/evidence/M07/v5-source-rebuild-S3GrBg'
$isolated = 'E:/DreamMakerSuite/pi-go-zEj3X1'
$piPackage = 'D:/AI/AgentStack/node-global/node_modules/@earendil-works/pi-coding-agent'
node "$kit/reproduce.mjs" "$registered/cli-responses/build.json" $isolated
# 将本次脚本输出的 pi-build-* 完整目录赋给 $buildDir。
$buildDir = Read-Host '本次 pi-build 目录'
node "$kit/physical.mjs" "$buildDir/build.json" $piPackage
# 将本次脚本输出的 physical-* 完整目录赋给 $physicalDir。
$physicalDir = Read-Host '本次 physical 目录'
node "$kit/prior-regression.mjs" "$buildDir/build.json" 'integrations/magpie/v5-cli-responses/process-test.mjs' "$registered/dream-maker-magpie.exe" "$physicalDir/exectest.exe"
```

每次运行创建新的输出目录。Go 包测试在临时测试覆盖层中把历史断言的固定证据目录替换为本次独立目录。该覆盖层只参与单元测试。TLS 测试镜像单独编译，使用 Go 标准库测试证书，所有服务绑定回环地址。原始候选接受相同请求后在 TLS 阶段终止。历史套件通过摘要核对旧脚本及其冻结的控制二进制。

## 实测范围

54 项 Pi 物理检查覆盖两协议、旧基线、生产候选证书负例、测试镜像、错误角色或账号、模型替换、请求变更、重放和无效 SSE。每协议真实 Pi CLI 在测试镜像上完成两轮、一次工具读取和最终文本。每轮 SDK 与物理账本均断言 input 7、cacheRead 2、cacheWrite 0、output 4。旧套件的 71 项覆盖历史四格。构建输出及报告均标记 `NOT_VERIFIED`，付费调用为零。产品账号资格和正式发布由上层另行验证。
