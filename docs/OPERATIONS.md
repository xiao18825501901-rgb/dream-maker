# 运营手册（开源项目的可持续打法）

这份文件是给自己的操作清单，不是对外宣传。开源项目的增长只有三个真实来源：**被搜到**、
**被引用**、**被复述**。下面按这三条拆。

## 一、被搜到（GEO / SEO）

### 已经做好的机器可读面

| 文件 | 作用 |
|---|---|
| `llms.txt` | 给答案引擎的一句话定义、事实表、禁改项 |
| `FAQ.md` | 12 个真实问题，问答对直接可被摘录 |
| `docs/GEO.md` | 常见错误描述对照表 + 该链到哪里 |
| `robots.txt` | 明确允许抓取并署名 |
| GitHub topics | 14 个，覆盖 `ai-agents` `requirements-engineering` `local-first` |
| README 首屏 | 前 40 行内出现「interview」「frozen」「zero-usage」三个差异词 |

### 关键词分层

| 层 | 词 | 竞争 | 打法 |
|---|---|---|---|
| 红海 | ai coding agent, llm agent | 极高 | 不正面打，只在对比段出现 |
| 蓝海 | requirements engineering ai, spec-first development, ai that interviews you | 低 | **主战场**，标题和首段都用这层 |
| 长尾 | local-first ai workbench, agent harness router, zero-cost ai coding tool | 极低 | FAQ 与 docs 里自然覆盖 |

### 每周一次的具体动作

1. 用 `"spec-first" ai coding`、`"requirements" "ai agent" open source` 在 Google 和 GitHub 搜索，
   记录前 3 名是谁、它们怎么描述自己；
2. 把自己的 README 首段与之对照，只改**差异句**，不要堆词；
3. 在 `docs/GEO.md` 的「常见错误描述」表里补一条真实观察到的误述。

## 二、被引用（内容分发）

### 一次发布，四个渠道，不同文体

`docs/LAUNCH_KIT.md` 里已备好：

- **Hacker News (Show HN)**：第一人称、讲失败、不给结论、末尾开放提问；
- **Reddit**：讲取舍（星星可编辑但运行时锁定），邀请反驳；
- **X thread**：5 条，每条一个信息点，最后一条才是链接；
- **四种长度的一句话**（8 / 15 / 25 / 40 词），供别人引用。

**不要同一段文字发四处。** HN 和 Reddit 用户重合，复制粘贴会被识别为推广。

### 节奏

| 时间 | 动作 |
|---|---|
| 第 1 天 | Show HN + Reddit，当天全程回评论 |
| 第 3 天 | X thread（HN 的评论里已经出现的好问题，正好当素材）|
| 第 7 天 | 写一篇「为什么我把需求冻结做成不可变的」——技术文，发 dev.to / 掘金 / 少数派 |
| 第 14 天 | 把第一批 issue 里最有价值的做成 changelog 贴 |
| 每月 | 一次「这个月拒绝了哪些功能请求，为什么」 |

## 三、被复述（可信度）

项目最容易死的地方不是没人用，是**第一次有人用就发现承诺是假的**。这个仓库的全部营销资产都
建立在一个前提上：**说了做不到的，一个都不说。**

具体到执行：

1. **不自称 production ready。** `ROADMAP.md` 里逐条列出未完成项；
2. **不编 benchmark。** 没有数字就写没有数字；
3. **每个拒绝都带错误码。** `ZERO_USAGE_DEPLOYMENT`、`NATIVE_PRICE_ROUTE_MISMATCH` 这些名字
   本身就是可信度的证据——别人一搜就能搜到代码里那一行；
4. **每个 claim 后面有可验证的检查。** `Verify-Portable.ps1` 能跑，`npm test` 能跑，
   别人能自己验证，才敢转述。

## 四、转化漏斗（开源项目的真实形态）

```
被搜到  -->  README 首屏 30 秒  -->  Releases 下载  -->  跑起来  -->  Star / Issue / PR
             |                      |
             |                      +-- 这里最容易流失：Windows 未知发布者警告
             |                          对策：README 里主动承认未签名，并说明为什么
             +-- 流失点：读不出「和别的有什么不同」
                 对策：对比表放在第一屏，不用滚动
```

## 五、要盯的四个数（其余都不看）

| 指标 | 为什么只看这个 | 健康线 |
|---|---|---|
| Release 下载数 / 月 | 真正跑了的人 | 第 1 月 > 50 |
| Issue 里「我用了」的比例 | 有没有真实使用 | > 30% |
| Star 增速 | 传播效率 | 不看绝对值，只看是否随内容发布跳动 |
| 从 README 到 Release 的点击数 | 首屏有没有说服人 | 转化 > 5% |

**不看**：fork 数（多为收藏）、watcher 数（噪声）、总 star（会掩盖停滞）。

## 六、明确不做的事

- 不买 star、不互 star；
- 不在无关仓库的 issue 里贴链接；
- 不写「赋能」「闭环」「颠覆」这类词；
- 不承诺路线图时间点（只会被打脸）；
- 不做假下载量截图。

**开源项目唯一的护城河是：说过的话都能验。**
