# DM专属Magpie入口增量（未验收）

## 当前继续点：进程内账户与短效凭据（2026-11-03）

最新候选SHA256 22c48813af84169f9587086959a32685e28d12fbe4f44c225a1f6f689f08092c。14项overlay包含3处有原始基线摘要的最小替换；账户与短效网关凭据均先以明确空目录启用内存保护。原始磁盘账户不导入，旧LAN写回、快照恢复和预算起点变更拒绝；过期凭据释放容量。13项合成凭据结果、8项网关定向及26项最新本机进程检查通过，具体范围见docs/magpie/M07_VOLATILE_ISSUER_RESULT_20261103.md。尚未接真实账户来源、限定签发控制协议及NativeOwner正向派发；Custom仍关闭、真实凭据仍不允许。以下各候选与“全部新增”表述按历史版本阅读。

## 规范账户映射合同（2026-11-03）

新候选SHA256 c57aa764055df5732d650c1a90af302fba28061e68548677477a3fded7b31d30（54,049,280字节）。本地accountRef与规范upstreamAccountRef已分离；原routeHash绑定账户映射/Runtime/模型/接口/认证来源，Node在Intent前、Go在密钥查询前拒绝不一致。实际authorize核对规范上游账户；不关闭NO_ACCOUNTS，不改共享配置。Node40/Go17及实际进程19检查通过，均无真实账户/模型；注册表、限定Key装配和Custom正向Factory仍未完成，不能以本合同启用真实凭据或称完整安全资格。见docs/magpie/M05_ACCOUNT_MAPPING_RESULT_20261103.md。下方账户缺口说明及旧候选为历史。

后续固定源核对发现正向账户接线仍有具体缺口：DM本地accountRef别名与上游限定密钥使用的provider/account形式不能直接等同。见docs/magpie/M05_ACCOUNT_ALIAS_GAP_20261103.md。现有否定/恢复检查不能替代该正向验证；尚未修改Go合同解决此处，也不能通过关闭账户发现保护或手改keys放行。

## 控制回执增量（2026-11-03）

新候选SHA256为75a8e0c21a51bea0c61dd49a69ba0c705a19df1502dd25ab30fe13f81f2c69f6（54,037,504字节）。原绑定/路由摘要及精确控制帧回执v2已实现；原NativeBudget保存一次性Intent，生产管道客户端匹配回执并在丢失时保留UNKNOWN。13项Go合成后端检查与14项实际专属进程负面/恢复检查通过，均没有真实模型或账户。Custom的原Engine正向Factory、真实账户路由与无隐式账户文件访问审计仍未完成，不能承载真实凭据或作为发行安全资格。详见docs/magpie/M06_CONTROL_PIPE_RESULT_20261103.md。下文是早期候选的历史证据，未替新候选自动续期。

## 2026-11-03 继续点

已用固定Go1.26.8和固定上游源码完整编译Windows候选，实际二进制SHA256为 `eb42ae75319b2bddf3059ba937ce73cb43c33901111b91937174c81f4cfccc3c`（54,033,408字节）。原始端口/密钥签发/模型目录等未授权访问、唯一回环监听、控制管道EOF退出、重启和异常控制关闭的21项实际进程检查通过；未供给真实账户或模型凭据，未发模型调用。实际二进制28个依赖的ZIP和已展开目录h1均与固定go.sum逐项匹配。

候选仍不能用于Custom Live：原Engine预算/冻结配置的派发授权与合法账户路由尚未接完，正向授权、账户发现文件访问审计和真实多角色未验收；完整传递许可/发行也未批准。原Engine继续拒绝CUSTOM_MAGPIE_SECURITY_REQUIRED。见 `docs/magpie/M05_REAL_CANDIDATE_20261103.md`。以下保留最初检查点历史。

## 最初检查点

只应用于固定upstream commit `1aca55909ff94f5c23091ce35f73cb4b7bc46658`，Go1.26.8。上游完整7541份Git blob及官方Go ZIP已核验；UPSTREAM_LICENSE和UPSTREAM_THIRD_PARTY_NOTICES原文保留。此目录是原DM的构建增量，不是另一个Engine，也不修改已安装的Magpie/Codex/DSH或系统代理。

overlay新增三个Go文件：独立最小入口、同进程原始listener的逐请求授权、其测试。没有替换upstream原文件。入口不调用上游cli.Main/ListenAndServe，不启动其额外WSL/LAN监听、账户维护、用量消耗、插件更新或桌面UI。可信控制管道才可提交授权；HTTP没有issuer入口。逐次授权绑定项目/Flow/角色/Executor/冻结配置/费用预留引用、具体账户模型、原始body摘要、精确方法/路径、epoch与截止时间；一次使用后不可重新颁发同ID/token。原Engine的真实预留/身份核验仍必须接入，引用本身不是已授权的证据。

10项Go测试通过，使用合成HTTP后端，属于SELF_REVIEW。没有把它们算真实Magpie、模型或角色Live；第一次冷编译在输出缺实现错误后到达300秒上限，第二个明确合同反例正常exit1；最终实现测试exit0。gofmt后原代码只做格式变化，主入口尚未编译通过。

完整上游候选构建到达300秒时限，未产出已验证二进制；go.mod/go.sum字节未改变。全依赖下载也有一次300秒中止，不能宣称依赖、SBOM、许可或构建已经完成。证据：F:\DreamMakerSuite\evidence\M05\toolchain-20261103；入口测试：go-ingress-reviewed-20261103.log。没有启动任何候选网关或读取真实账户。

当前Custom仍由原Engine拒绝CUSTOM_MAGPIE_SECURITY_REQUIRED。真实原始端口/issuer/WSL/LAN/重放/最终账户路由/无隐式发现/进程退出与恢复验收均NOT_RUN；绑定原Engine、账本和真实运行器仍未完成。严禁把本候选带真实凭据或作为已安全组件发布。

所有者已调整优先级：保存本切片后，优先Classic真实四角色；不等本目录其余功能完成。见docs/continuation/CLASSIC_LIVE_PRIORITY_20261103.md。
