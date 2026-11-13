import { normalize } from '../plugins/keywords/extract.js';

// 常见叙述词不能单独充当检索概念，也不能用来拼接名词短语。
const STOP = new Set(('的 了 和 是 在 与 及 一个 我们 你们 用户 助手 本文 本次 当前 后续 已有 现有 原有 这个 那个 这些 那些 可以 进行 使用 通过 需要 已经 然后 因为 所以 如果 但是 对于 关于 以及 降低 改善 能够 选择 合适 制作 用于 注意 保持 提高 减少 增加 实现 支持 采用 包括 具有 分别 提交 修改 改动 仍未 尚未 不再 不能 不要 不会 无法 不应 不得 不必 没有 不存在 已完成 完成 开始 结束 确认 要求 说明 表示 认为 建议 计划 结果 记录 证据 时点 所列 为准 实际 版本 状态 工作 工作区 文件 文档 内容 问题 处理 方式 情况 部分 范围 对象 信息 目标 相关 对应 通用 正式 最小 默认 第一 第二 三个 两个 每个 所有 其他 同时 之后 之前 随后 最后 最初 仍然 只是 只要 必须 继续 暂时 立即 正在 直接 间接 显式 自动 完整 正确 错误 简单 明确 可靠 核对 新增 更新 写入 读取 返回 调用 执行 生成 创建 删除 恢复 清理 验收 发布 归档 推送 合并 合回 整合 检查 测试 验证 统计 发现 解决 排查 定位 调整 补充 修复 改为 改成 变成 转为 避免 防止 导致 影响 决定 判断 确定 允许 拒绝 保留 提供 进入 离开 打开 关闭 失败 成功 共用 复用 并且 或者 否则 而且 不过 仅仅 至少 至多 大约 例如 比如 其中 这里 因此 也 未 并 又 但 仍 不 无 有 从 到 按 把 被 为 对 将 让 先 再 后 前 时 上 下 中 内 外 可 能 应 其 所 该 即 等 另 页 次 项 个 篇 行 条 轮 端 侧 ' +
  'the and for with from this that are was were you your our their to of is a an as at by or on in into not no can could should would may will be been being it its if else then than do does did done must all any some other more most less only also just still already never always first last next new old current existing previous following used using use add added update updated remove removed create created fix fixed feat docs test tests pass passed run running result results include includes return returns begin end before after true false null undefined').split(/\s+/));

// 追溯模板不能因跨文档重复晋升为概念。
const BOILERPLATE = /^(?:#{1,6}\s*)?(?:来源与追溯|来源追溯|整理范围|整理日期|原拆分编号|验证记录|提交与合回状态)(?:\s|[：:]|$)|本文是会话事务的整理|状态以所列证据时点为准|新增的通用执行建议不表示/u;
const SENTENCE_PART = /(?:仍未|尚未|不要|不能|不会|不应|不得|不再|以所列|为准|之后|之前|如何|为何|怎样|是否|已经|已完成|计划开始|实施完成|相关工作|用户提出|用户确定|要求按|优先于)/u;
const HAN_PARTICLES = new Set('的 了 是 在 与 及 和 把 被 将 让 按 从 到 于 而 并 或 但 其 所 该 这 那'.split(' '));
const GENERIC = new Set('readme artifacts verification implementation contracts running summary version main master origin md ts js mjs tmp log dev dist src doc read write data text item items value name id true false null undefined semantic keywords tag tags browsing before after currently'.split(' '));
const MAX_TERM_CHARS = 40; // 支持产品全名、API 和短术语，拒绝完整句子。
// 缺少字段或标题证据时，独立泛名词不能仅凭高向量分数入选。
const WEAK_ATOMS = new Set('候选 日期 实例 输入 输出 内部 单一 未知 类型 方向 顺序 操作 关系 结果 分类 筛选 批量 处理 说明 对象 资源 信息 属性 内容 工作 项目 任务 方式 正文 标题 方案 计划 情况 部分 实际 当前 固定 原始 重复 单轴 位置 兼容 隐藏 展开 声明 原子 可信 持久 透明 动态 活动 单例 局部 纯函数 规则 边界 基线 证据 参数 字段 工具 预算 成本 性能 内存 元素 模块 组件 节点 依赖 引用 方法 函数 服务 端口 进程 线程 网络'.split(' '));
const ENGLISH_TERMS = new Set('agent codex claude cursor serena git npm node nodejs typescript javascript python rust java kotlin swift vue react vite playwright chrome windows linux macos sqlite postgres mysql redis embedding embeddings reranker transformers tokenizer pooling cosine softmax sigmoid manifest inventory snapshot compact baseline delta spec openspec session transcript cron scheduler queue streaming schema namespace metadata uuid hash sha aes jwt bearer json jsonl yaml xml html css svg png jpeg jpg webp astc rgb rgba pma api cli mcp http https tcp udp ipc rpc sdk cpu gpu ram nfc nfkc unicode utf8 regex markdown browser texture prefab sprite canvas layout bitmap render quaternion vector matrix transform anchor tween spritesheet atomic transaction rollback commit branch worktree diff merge rebase stash mutex semaphore cache batch pagination scope timeout retry budget prompt tokens token parser compiler bundler validation assert normalize import export module await async promise null undefined unsubscribe subscribe emit dispose handler priority onnx pngquant oxipng esbuild tsx tsc rg fs bm25 recall ngram'.split(' '));
const TECH_LITERAL = /^(?:null|undefined|true|false)$/u;
const VERSION_TERM = /^(?:v\d+(?:\.\d+)+|\d+(?:\.\d+){2,})(?:-[a-z][\w.-]*)?$/iu; // 裸版本至少三段；v 前缀允许两段，整串匹配避免小数和长版本截断。
const ENGLISH_DISCOURSE = new Set('app application introduction conclusion summary reproduction analysis discussion results examples overview setup design plan validation implementation status notes background commit'.split(' '));
const WEAK_CONTEXT = new Set('常量 界面 分支 经验 结论 增量 字节 完整性 设计 签名 交付 现状 变化 推测 澄清 核实 核查 回归 主题 原理 意义 方法论 需求'.split(' '));
// 标题中的时间、任务动作与问句仍是叙述，不直接作为概念。
const NARRATIVE_TITLE = /(?:为什么|怎么|如何|为何|怎样|近[一二两三四五六七八九十\d]+[天周月年]|最终|现状|变化|推测|澄清|核实|核查|交付|上报|实施|回归|重划|排查过程|发生的事|要解决的事)/u;
// 正文缺少词性标注时，以通用技术名词原子约束组合；显式关键词不受此词表限制。
const NOUNS = new Set(('代码 图谱 符号 引用 动态 调用 证据 核查 字段 投影 组件 实例 解析 命令 中心 单一 处理者 结果 副作用 边界 规则 场景 配方 接口 替身 构建 复用 故障 分类 脚本 声明 序列化 槽位 事务 类型 关键词 召回 标签 关联 关系 评分 候选 版本 蓝湖 导出 设计 事实 组装 逻辑 绑定 优先级 日期 固定 快照 替代 全文 检索 任务 切分 墙钟 耗时 缓存 输入 工具 批次 结构化 日志 轮转 诊断 入口 脱敏 节点 层级 兄弟 顺序 游标 路由 认知 成本 行为 可控性 初始化 串行 操作 内部 展开 错误 索引 原子 写入 事件 泛型 契约 监听 作用域 统计 偏差 配对 完成 中位数 正确率 增量 压缩 可信 源图 持久 备份 未知 编辑 保护 替换 项目 基线 变更 单元 误拒 抽样 误差 隐藏 品质 校验 实验 透明 调色板 重复 预乘 色块 子树 多组件 筛选 同页 分页 完整性 会话 失败 归因 证据链 智能 对象 资源 裁剪 变换 渲染 等价 同题 对照 回传 字节 资产 哈希 规范 活动 同步 归档 精简 局部 更新 单轴 位置 参数 兼容 别名 预览 映射 原点 坐标 不确定性 分层 架构 依赖 方向 单例 生命周期 注入 流程 编排 退出码 量化 回退 纹理 压缩率 有损 无损 多态 元数据 向量 索引 签名 代次 词表 词频 分词 停用词 归一化 模型 编码 算法 召回率 精确率 预算 内存 性能 并发 互斥 重试 租约 权限 令牌 插件 队列 服务 网络 端口 进程 线程 工作树 分支 提交 远端 仓库 协议 参数 属性 实体 控件 界面 表格 窗口 页面 表单 按钮 弹窗 金额 提现 奖励 等级 玩家 修为 音频 图片 图像 尺寸 宽度 高度 坐标系 世界 本地 布局 锚点 缩放 旋转 颜色 字体 动画 动效 支付 数据库 查询 主键 外键 缓冲区 连接池 连接 连接器 代理 请求 响应 载荷 回调 订阅 派发 优先级 执行器 处理器 监听器 观察者 工厂 生命周期 稳定性 一致性 原子性 可用性 扩展性 可维护性 安全性 时效性 相似度 温度 上下文 记忆 知识库 笔记 文本 正文 摘要 提示词 分块 片元 历史 元素 命名空间 空间 域名 目录 树形 树 预制体 平台 批量 函数 方法 枚举 泛型 常量 对象 属性 错误码 锁 事务锁 写锁 重做 水位 租约 顺序 中断 幂等 幂等性 限流 超时 复合 原生 纯函数').split(/\s+/));
const NARRATIVE = new Set('显示 管理 讨论 讲解 回应 回复 贴出 指出 证明 解释 报告 报错 依靠 依赖于 看作 视为 变更 通知 等待 完成后 选定 尚无 产生 引入 拆成 拆分 重新 进一步 反复 顺带 按照 基于 根据 承接 落档 带入 写到 写成 传入 传给 统一 同样 不同 相同 较高 较低 最多 最大 最少 保证 除非 仅有 暂不 不做 准备 接着 换成 沿用 本地 远端 上述 以下 下方 上方 大量 少量 整体 独立 合法 非法 普通 历史 后台 前台'.split(' '));

export function isStopWord(value: string): boolean { const word = normalize(value); return STOP.has(word) || NARRATIVE.has(word); }
export function isBoilerplate(text: string): boolean { return BOILERPLATE.test(text.trim()); }
export function isConceptAtom(value: string): boolean { return NOUNS.has(value); }
export function isWeakAtom(value: string): boolean { const word = normalize(value); return word==='中心' || WEAK_ATOMS.has(word) || WEAK_CONTEXT.has(word); }
export function isNarrativeTitle(value: string): boolean { return NARRATIVE_TITLE.test(value); }
export function isVersionTerm(value: string): boolean { return VERSION_TERM.test(value); }
/** 普通英文必须有技术词形或实体形态证据，避免从叙述句提取 because、doing。 */
export function isEnglishConcept(value: string): boolean {
  if (/\p{Script=Han}/u.test(value)) return true;
  if (ENGLISH_TERMS.has(normalize(value)) || isVersionTerm(value)) return true;
  if (/^[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){1,3}$/u.test(value)) return true;
  if (/^(?:git (?:status|diff|log|show|commit|branch|merge|rebase|worktree)|npm (?:ci|install|run|test)|node --[\w-]+)$/u.test(value)) return true;
  if (/^[A-Z][A-Z\d_-]{1,}$/u.test(value) || /[a-z\d][A-Z]/u.test(value) || /^[A-Za-z]\w*(?:[_.][A-Za-z]\w*)+$/u.test(value)) return true;
  if (/^[A-Z][a-z]{2,}$/u.test(value) && !/^(?:Personal|Project|Center|Before|After|Because|Selected|Settings|Denied)$/u.test(value)) return true;
  return /^(?:[a-z]+-)*(?:mcp|cli|sdk)$|^(?:codebase-memory|project-tracking|knowledge-base)$/u.test(value);
}

/** 词形必须可以独立展示；相关性另外由来源与语义决定。 */
export function isUsefulTerm(value: string, explicit = false): boolean {
  const word = normalize(value);
  if (explicit && TECH_LITERAL.test(word)) return true;
  if (word.length < 2 || word.length > MAX_TERM_CHARS || isStopWord(word) || GENERIC.has(word) || ENGLISH_DISCOURSE.has(word)) return false;
  if (isVersionTerm(word)) return true;
  if (!/\p{L}/u.test(word) || /^[a-f\d-]{6,}$/i.test(word) || /^(?=.*\d)[a-f\d]{4,}$/i.test(word) || /^[pt]\d+$/i.test(word)) return false;
  if (/[/\\]|https?:|[。！？!?，,；;：:（）(){}\[\]<>="“”%]/u.test(word)) return false;
  if (/\.(?:md|json|js|ts|mjs|png|jpg|log|txt|exe|sqlite|csv|zip|html|test|spec|tap|vue|toml|lock|yaml|yml|bat|ps1|onnx|config)$/iu.test(word) || /(?:^|\s)v?\d+(?:\.\d+){2}/iu.test(word)) return false;
  if (SENTENCE_PART.test(word) || isBoilerplate(word)) return false;
  if (/\p{Script=Han}/u.test(word)) {
    if (word.length > 14 || /\s/u.test(word) && /\p{Script=Han}\s+\p{Script=Han}/u.test(word)) return false;
    const parts = Array.from(new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(word)).filter(x => x.isWordLike);
    if (/\s/u.test(word) && parts.some(part => isStopWord(part.segment))) return false;
    if (parts.some(part => HAN_PARTICLES.has(part.segment))) return false;
    if (/^(?:并|按|从|到|含|为|对|将|以|把|被|让|当|但|仍)$/u.test(parts[0]?.segment ?? '') || /^(?:仍|未|不|为|于|从|到|后|前|中|上|下|内|外)$/u.test(parts.at(-1)?.segment ?? '')) return false;
  } else if (/\s/u.test(word)) {
    const words = word.split(' ');
    if (words.length > 4 || words.some(x => STOP.has(x) || GENERIC.has(x) || ENGLISH_DISCOURSE.has(x))) return false;
  }
  return true;
}
