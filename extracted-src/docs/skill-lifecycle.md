# Skill 加载与调用完整链路

本文档梳理 Claude Code 中 skill（技能/斜杠命令）从加载到调用的完整生命周期。

---

## 一、启动阶段：Skill 加载与注册

Skill 有 6 种来源，加载时机各不相同。

### 1. Bundled Skills（内置技能）— 启动时同步注册

```
main.tsx:1924-1925
  ├── initBuiltinPlugins()
  └── initBundledSkills()                    // src/skills/bundled/index.ts:24
       ├── registerUpdateConfigSkill()
       ├── registerKeybindingsSkill()
       ├── registerVerifySkill()
       ├── registerDebugSkill()
       ├── registerLoremIpsumSkill()
       ├── registerSkillifySkill()
       ├── registerRememberSkill()
       ├── registerSimplifySkill()
       ├── registerBatchSkill()
       ├── registerStuckSkill()
       └── ...（feature-gated: dream, hunter, loop 等）
            └── registerBundledSkill(def)    // src/skills/bundledSkills.ts:53
                 └── bundledSkills[] 数组    // 同步内存注册表
```

- **文件**: `src/skills/bundled/index.ts`, `src/skills/bundledSkills.ts`
- **关键点**: 必须在首次 `getCommands()` 之前完成注册，否则会 race 到空列表（见 `setup.ts:290` 注释）

### 2. 磁盘 Skill 目录 — 首次需要时异步加载

```
getCommands(cwd)                          // src/commands.ts:476
  └── loadAllCommands(cwd)                // src/commands.ts:449, memoized
       └── getSkills(cwd)                 // src/commands.ts:353
            └── getSkillDirCommands(cwd)  // src/skills/loadSkillsDir.ts:638, memoized
                 ├── managed/policy: ~/.claude/skills (policy path)
                 ├── user:        ~/.config/claude-code/skills
                 ├── project:     .claude/skills (从 cwd 向上遍历到 home)
                 ├── additional:  --add-dir 指定目录的 .claude/skills
                 └── legacy:      /commands/ 目录（兼容旧格式）
```

每个目录的加载流程 (`loadSkillsFromSkillsDir`, `loadSkillsDir.ts:407`)：
1. 遍历子目录，读取 `skill-name/SKILL.md`
2. `parseFrontmatter()` 解析 YAML frontmatter
3. `parseSkillFrontmatterFields()` 提取各字段
4. `createSkillCommand()` 构造 `Command` 对象
5. 按 realpath 去重
6. 分离为 unconditional + conditional（含 `paths:` frontmatter 的）

### 3. Plugin Skills — 插件提供

- `getPluginSkills()` 从已安装插件加载
- `getBuiltinPluginSkillCommands()` 从内置插件加载

### 4. MCP Skills — MCP 服务器提供

- MCP server 连接后通过 `appState.mcp.commands` 提供
- `SkillTool.getAllCommands()` 中合并入本地列表
- `registerMCPSkillBuilders()` 在 `loadSkillsDir.ts` 模块初始化时注册构建器，避免循环依赖

### 5. 动态发现 Skill — 会话中按需发现

| 机制 | 触发时机 | 入口函数 |
|---|---|---|
| **目录发现** | 文件操作（Read/Write/Edit）时向上遍历 `.claude/skills/` | `discoverSkillDirsForPaths()` → `addSkillDirectories()` |
| **条件激活** | 文件路径匹配 skill 的 `paths:` frontmatter | `activateConditionalSkillsForPaths()` |
| **热重载** | 磁盘文件变化（chokidar + 300ms debounce） | `skillChangeDetector.ts` → 清缓存 + `skillsChanged` 信号 |

动态 skill 存入 `dynamicSkills` Map，`getCommands()` 每次调用时合并。

---

## 二、暴露给模型：Skill 如何被知道

> **注意**: skill **清单**（名称+描述列表）不在 system prompt 里。System prompt 只有一句使用方式说明。具体的 skill 列表通过对话消息附件注入。

模型通过三层机制感知 skill：

### 1. System Prompt — 使用方式说明（无清单）

**文件**: `src/constants/prompts.ts:352-400, 457-494`

```
getSystemPrompt()
  → getSkillToolCommands(cwd)         // 只用来判断 hasSkills，决定是否显示说明文字
  → getSessionSpecificGuidanceSection(enabledTools, skillToolCommands)
     └─ 输出一句话指导:
        "/<skill-name> (e.g., /commit) is shorthand for users to invoke a
         user-invocable skill. When executed, the skill gets expanded to a
         full prompt. Use the Skill tool to execute them.
         IMPORTANT: Only use Skill for skills listed in its user-invocable
         skills section - do not guess or use built-in CLI commands."
```

- **没有**具体 skill 名称/描述
- 只告诉模型"有 skill 这个东西，用 Skill 工具调用"
- 放在 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 之后，避免打散全局 prefix cache

### 2. Skill 列表附件（skill_listing）—— 真正的"清单"

- **形式**: `skill_listing` 类型的 attachment 消息
- **注入时机**: 每轮工具执行后，通过 `getAttachmentMessages()` 注入到对话中
- **位置**: `attachments.ts:875` → `getSkillListingAttachments()` (`attachments.ts:2661`)
- **预算**: 约上下文窗口的 1%（`tools/SkillTool/prompt.ts:21-23`）
- **格式化**: `formatCommandsWithinBudget()` — bundled skill 完整描述，其余按预算截断
- **增量发送**: 用 `sentSkillNames` 记录已发送的 skill，只发增量；没有变化时不发

### 3. SkillTool 工具定义

模型通过 tools 参数知道有一个叫 `Skill` 的工具可以调用：

- **名称**: `SKILL_TOOL_NAME = 'Skill'`
- **输入 schema**: `{ skill: string, args?: string }`
- **工具描述 prompt**: `getPrompt()` — 说明何时调用 Skill 工具、调用方式、注意事项
- **工具描述里也不含具体 skill 列表**，只说"可用的 skill 在 system-reminder 消息里列出"

---

## 三、query.ts 中的 Skill 发现预取

> Feature flag: `EXPERIMENTAL_SKILL_SEARCH`
> 模块: `./services/skillSearch/prefetch.js`（条件 require）

### 第一步：启动预取（每轮循环开始）

**位置**: `src/query.ts:331-335`

```typescript
const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
  null, messages, toolUseContext,
)
```

- **时机**: 每轮 query 迭代开始时
- **方式**: 异步后台运行，与模型流式调用并行
- **作用**: 根据当前对话内容搜索相关 skill（本地索引 + 远程）

### 第二步：消费发现结果（工具执行后）

**位置**: `src/query.ts:1620-1628`

```typescript
if (skillPrefetch && pendingSkillPrefetch) {
  const skillAttachments = await skillPrefetch.collectSkillDiscoveryPrefetch(...)
  // 以 attachment 形式注入对话，下一轮模型可见
}
```

---

## 四、调用阶段：两条路径

### Path A：用户输入 `/skill-name args`（斜杠命令）

```
processUserInput()
  src/utils/processUserInput/processUserInput.ts:85
  │
  └─ 以 "/" 开头 → processSlashCommand()
       src/utils/processUserInput/processSlashCommand.tsx:309
       │
       └─ getMessagesForSlashCommand()    // :525
            │
            ├─ fork 模式: executeForkedSlashCommand() → runAgent()
            │
            └─ inline 模式: getMessagesForPromptSlashCommand()  // :827
                 ├── command.getPromptForCommand(args, ctx)  ← 加载 skill 内容
                 ├── registerSkillHooks()       ← 注册 skill hooks
                 ├── addInvokedSkill()          ← 压缩时保留 skill 内容
                 └── 返回 { messages, shouldQuery: true }
                      └─ skill 内容作为 user message 进入对话
                      └─ query() 循环处理 skill 内容
```

### Path B：模型主动调用 Skill 工具

```
query() loop
  src/query.ts:219
  │
  ├─ deps.callModel()               → 模型返回 tool_use: "Skill"
  │
  ├─ streamingToolExecutor / runTools()
  │   src/services/tools/toolOrchestration.ts
  │   │
  │   └─ runToolUse()               // toolExecution.ts
  │        ├─ SkillTool.validateInput()    // 校验名称 + 存在性
  │        ├─ SkillTool.checkPermissions() // allow/deny/ask 决策
  │        └─ SkillTool.call()             // src/tools/SkillTool/SkillTool.ts:580
  │             │
  │             ├─ 远程 skill (ant-only + EXPERIMENTAL_SKILL_SEARCH)
  │             │   └─ executeRemoteSkill()
  │             │        ├─ loadRemoteSkill(slug, url)  // 从 AKI/GCS 加载
  │             │        ├─ 解析 frontmatter + 变量替换
  │             │        ├─ addInvokedSkill()
  │             │        └─ 直接注入 user message
  │             │
  │             ├─ fork 模式 (command.context === 'fork')
  │             │   └─ executeForkedSkill()
  │             │        ├─ prepareForkedCommandContext()
  │             │        └─ runAgent()            // 子 agent 中执行
  │             │
  │             └─ inline 模式（默认）
  │                  └─ processPromptSlashCommand()
  │                       └─ getMessagesForPromptSlashCommand()  ← 同 Path A
  │                            └─ 返回 newMessages + contextModifier
  │
  ├─ newMessages 注入对话（skill 内容成为上下文）
  ├─ contextModifier 应用（allowedTools / model / effort）
  └─ 循环继续 → 模型处理 skill 内容，继续对话
```

---

## 五、Skill 调用的副作用

| 副作用 | 入口 | 作用 |
|---|---|---|
| **压缩保留** | `addInvokedSkill()` (`bootstrap/state.ts`) | skill 内容存入状态，auto-compact 后可恢复 |
| **Hook 注册** | `registerSkillHooks()` (`registerSkillHooks.ts`) | skill frontmatter 中的 hooks 注册到会话生命周期 |
| **工具权限** | `contextModifier` → `alwaysAllowRules.command` | skill 的 `allowed-tools` 加入自动允许列表 |
| **模型覆盖** | `contextModifier` → `mainLoopModel` | skill 指定的 model / effort 生效 |
| **使用记录** | `recordSkillUsage()` | 记录使用频次，用于排序 |

---

## 六、完整时序图

```
应用启动
  │
  ├─ initBundledSkills()          ← 同步注册内置 skill
  │
  ├─ setup() / 首次 getSystemPrompt()
  │   └─ getSkillToolCommands()   ← 首次触发磁盘 skill 加载
  │       └─ getSkillDirCommands()
  │           └─ 扫描所有 skill 目录
  │
用户输入消息
  │
  ▼
processUserInput()                   ← 【0】用户输入处理（queryLoop 之前）
  │
  └─ getAttachmentMessages()
      ├─ @-mentioned files
      ├─ mcp_resources
      ├─ agent_mentions
      ├─ turn-0 skill_discovery       （首次对话的语义推荐，EXPERIMENTAL_SKILL_SEARCH）
      ├─ queued_commands
      ├─ changed_files
      ├─ nested_memory
      └─ skill_listing attachment     ← ★ 首轮全量 skill 清单在此注入
          （sentSkillNames 为空 → 发全量）
  │
  ▼
query() 函数被调用 → queryLoop() 主循环
  │
  ├─ startSkillDiscoveryPrefetch()    ← 【1】skill 发现预取启动，与 API 并行
  │
  ├─ (各种 compact: snip/microcompact/autocompact/reactiveCompact)
  │
  ├─ deps.callModel()                 ← 【2】调用模型 API
  │   │
  │   ├─ system prompt 里只有 Skill 工具使用说明（无清单）
  │   ├─ 消息里已包含 skill_listing attachment（步骤【0】注入）
  │   └─ 流式返回 assistant message
  │       └─ 可能包含 tool_use: "Skill"
  │
  ├─ streamingToolExecutor / runTools  ← 【3】工具执行
  │   └─ SkillTool.validate → checkPermissions → call
  │       └─ 展开该 skill 的完整内容为 user message
  │
  ├─ getAttachmentMessages()          ← 【4】轮间附件（mid-turn）
  │   ├─ memory attachments
  │   ├─ queued commands
  │   └─ skill_listing attachment      ← 增量更新（只发新增/变化的 skill）
  │       （sentSkillNames 已记录 → 只发差量）
  │
  ├─ collectSkillDiscoveryPrefetch()  ← 【5】skill 发现预取消费
  │   └─ skill_discovery attachment    ← 语义推荐的相关 skill
  │
  └─ state = next → continue          ← 下一轮循环（增量清单 + 推荐可见）
```

---

## 八、runTools 四个参数的来源

`runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)` 在 `query.ts:1382` 调用。

### 1. `toolUseBlocks: ToolUseBlock[]`

- **声明**: `query.ts:557`，初始为空数组
- **填充**: 流式循环中（`query.ts:829-835`），从每个 assistant message 的 `content` 里过滤 `type === 'tool_use'` 的 block 并追加
- **来源**: 模型 API 返回的 assistant message 中的 tool_use 内容块

### 2. `assistantMessages: AssistantMessage[]`

- **声明**: `query.ts:551`，初始为空数组
- **填充**: 流式循环中（`query.ts:827`），每个 `type === 'assistant'` 的消息都 push 进去
- **用途**: 关联 tool_use 所属消息、错误处理时生成缺失的 tool_result 等

### 3. `canUseTool: CanUseToolFn`

是一个权限检查函数，类型为 `(tool, input, context, assistantMessage, toolUseID, forceDecision?) => PermissionDecision`。

```
SDK 宿主 (interactiveHandler / permission system)
  │
  └─ QueryEngineConfig.canUseTool          QueryEngine.ts:136
     │
     └─ wrappedCanUseTool                   QueryEngine.ts:244-271
         (包一层追踪 permissionDenials)
         │
         └─ 作为 params.canUseTool 传入 query()
             一路透传到 runTools → runToolUse → checkPermissionsAndCallTool
```

### 4. `toolUseContext: ToolUseContext`

上下文对象，贯穿 query 生命周期不断被更新。

```
初始构造: processUserInputContext         QueryEngine.ts:335-395
  {
    messages,
    options: { tools, commands, mainLoopModel, mcpClients, ... },
    getAppState, setAppState,
    abortController,
    readFileState,
    discoveredSkillNames,
    ...
  }

每轮 queryLoop 中的更新:
  ① 添加 queryTracking                      query.ts:360-363
  ② 更新 messages                           query.ts:546-549
  ③ 工具执行后 newContext 修改              query.ts:1402-1407
  ④ refreshTools() 刷新工具列表             query.ts:1660-1671
  ⑤ 写入 state，下一轮循环使用              query.ts:1716-1717
```

---

## 九、runToolUse → SkillTool 跳转链路

`runToolUse` 是通用工具执行器，它通过多态调用分发到具体工具（包括 SkillTool）。

```
runToolUse(toolUse, assistantMessage, ...)   toolExecution.ts:337
  │
  │ ① 按名称查找工具
  ├─ tool = findToolByName(toolUseContext.options.tools, toolName)
  │    在 options.tools 数组里找到名字为 "Skill" 的 SkillTool 对象
  │
  │ ② Zod schema 类型校验
  ├─ tool.inputSchema.safeParse(input)       toolExecution.ts:615
  │    SkillTool 输入: { skill: string, args?: string }
  │
  │ ③ 业务逻辑校验
  ├─ tool.validateInput?.(parsedInput, ctx)  toolExecution.ts:683
  │    ↓
  │    SkillTool.validateInput()             SkillTool.ts:354
  │      - 去除前导 "/"
  │      - getAllCommands() 查找 skill 是否存在
  │      - 检查 disableModelInvocation
  │      - 检查 type === 'prompt'
  │
  │ ④ PreToolUse hooks
  ├─ runPreToolUseHooks()                    toolExecution.ts:800
  │
  │ ⑤ 权限检查
  ├─ resolveHookPermissionDecision()         toolExecution.ts:921
  │    ↓
  │    canUseTool → tool.checkPermissions()
  │    ↓
  │    SkillTool.checkPermissions()          SkillTool.ts:432
  │      - deny 规则检查
  │      - allow 规则检查
  │      - 安全属性白名单自动放行
  │      - 默认: ask（询问用户）
  │
  │ ⑥ 【关键跳转】执行工具
  └─ const result = await tool.call(         toolExecution.ts:1207
       callInput,
       { ...toolUseContext, toolUseId, ... },
       canUseTool,
       assistantMessage,
       onProgress
     )
       ↓
       SkillTool.call()                      SkillTool.ts:580
         ├─ 远程 skill (ant-only 实验性)
         │   → executeRemoteSkill()
         │     → loadRemoteSkill()
         │     → addInvokedSkill()
         │     → 直接注入 user message
         │
         ├─ fork 模式 (context === 'fork')
         │   → executeForkedSkill()
         │     → runAgent()
         │
         └─ inline 模式（默认）
             → processPromptSlashCommand()
               → getMessagesForPromptSlashCommand()
                 → command.getPromptForCommand()
                 → registerSkillHooks()
                 → addInvokedSkill()
```

**核心机制**: `runToolUse` 本身不知道什么是 skill，它只做通用分发——按 name 找 Tool 对象 → validate → checkPermissions → call。Skill 的特殊逻辑全部封装在 `SkillTool` 对象内部，通过 `tool.call()` 的多态调用进入。

---

## 十、Skill 清单注入时机

Skill 在模型侧的可见性分为三个层次：

### 1. System Prompt 中的使用说明

- **时机**: 每轮 `deps.callModel()` 时随 system prompt 发送
- **位置**: `getSessionSpecificGuidanceSection()` (`prompts.ts:352`)
- **内容**: 只有使用方式说明（"Use the Skill tool to execute them"），**不含具体 skill 列表**
- **缓存影响**: 放在 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 之后（`prompts.ts:344` 注释），避免打散全局 prefix cache

### 2. Skill 列表附件（主要方式）

- **时机**: 每轮工具执行后通过 `getAttachmentMessages()` 注入
- **位置**: `attachments.ts:875` → `getSkillListingAttachments()` (`attachments.ts:2661`)
- **机制**: **增量发送**，用 `sentSkillNames` Map 记录已发送过的 skill，只发 `newSkills`
  - 第 1 轮结束后：初始批量发送全部 skill（`isInitial: true`）
  - 后续轮次：只发增量（新发现/新增的 skill）
  - 没有变化时不发 attachment

### 3. Turn-0 Skill 发现（实验性）

- **条件**: `EXPERIMENTAL_SKILL_SEARCH` feature 开启
- **时机**: 用户输入处理时（`attachments.ts:789-813`）
- **方式**: `getTurnZeroSkillDiscovery()` 根据用户输入阻塞式搜索相关 skill
- **作用**: 解决第 1 轮模型还没看到 skill 列表的 gap

### 时序

```
用户输入
  │
  ├─ Turn-0 skill discovery (实验性)   ← 第 1 轮就能看到相关推荐
  │
  ▼
第 1 轮模型调用
  │  system prompt 里只有使用说明
  │
  ▼
工具执行 → 第 1 轮结束
  │
  └─ skill_listing attachment (初始批量)  ← 注入完整 skill 清单
     模型第 2 轮可见
  │
  ▼
第 2 轮模型调用
  │  可见完整 skill 列表
  │  可调用 Skill 工具执行具体 skill
  │
  ▼
模型输出 tool_use: { name: "Skill", input: { skill: "xxx" } }
  │
  ▼
SkillTool.call() → skill 内容展开注入对话
  │
  ▼
下一轮：模型基于 skill 完整内容继续工作
```

---

## 十一、Skill 热更新与缓存影响

### 热更新链路

磁盘上新增/修改/删除 skill 文件时：

```
SKILL.md 文件变化
  │
  ▼
chokidar watcher 检测 (skillChangeDetector.ts)
  │
  ├─ 300ms debounce
  │
  ▼
executeConfigChangeHooks('skills', ...)
  ├─ clearSkillCaches()              ← 清磁盘加载 memoize 缓存
  ├─ clearCommandsCache()            ← 清命令聚合缓存
  ├─ resetSentSkillNames()           ← 清空已发送记录（全量 clear）
  └─ skillsChanged.emit()
  │
  ▼
下一轮 query 结束时
  getSkillListingAttachments()
    ├─ sentSkillNames 为空 → 认为全量都是新的
    └─ 重新发送完整 skill_listing attachment（不是增量）
```

### 对 KV Cache 的影响

| 缓存层 | 受影响？ | 说明 |
|---|---|---|
| System prompt cache | 不受影响 | skill 列表不在 system prompt 里，system 部分哈希不变 |
| 历史消息 prefix cache | 不受影响 | skill_listing 在对话中后段，前面的消息哈希不变 |
| skill_listing 消息之后 | **失效** | 该 attachment 内容/位置变化，后续缓存 miss |

### 关键设计细节

- `resetSentSkillNames()` 是**全量清空** (`sentSkillNames.clear()`)，不是增量 diff。即使只改了一个 skill，也会重发完整列表 —— 这是工程上的权衡：增量追踪增删改太复杂，skill 列表 token 成本不高。
- skill 列表以 **user message attachment** 形式存在于对话流中，不是塞在 system prompt 里。这样 prefix cache 的稳定部分最大，只有 attachment 之后那一小段会 miss。
- skill 列表约占上下文窗口的 1%（`tools/SkillTool/prompt.ts:21`），单次 cache miss 的成本可控。

### 不同 skill 来源的发现延迟

| Skill 来源 | 发现时机 | 延迟 | 模型可见时机 |
|---|---|---|---|
| 用户目录 (~/.config/...) | chokidar watcher 实时检测 | ~300ms debounce + 1 轮 query | 下一轮 |
| 项目目录 (.claude/skills) | 文件操作时向上遍历发现 | 操作该目录下的文件后 + 1 轮 query | 下一轮 |
| 动态/条件 skill | 匹配 paths frontmatter 后激活 | 匹配后 + 1 轮 query | 下一轮 |
| MCP skill | MCP server 连接时 | 连接后 + 1 轮 query | 下一轮 |
| 插件 skill | 安装/启用插件时 | 安装后 + 1 轮 query | 下一轮 |

**共同规律**：skill 被发现后，最快**下一轮 query** 模型才能看到（需等当前轮结束，作为 attachment 注入后才发给模型）。

---

## 七、关键文件速查

| 文件 | 作用 |
|---|---|
| `src/query.ts:66-68, 331-335, 1620-1628` | skill 发现预取（加载 + 消费） |
| `src/skills/bundled/index.ts` | 内置 skill 注册入口 |
| `src/skills/bundledSkills.ts` | `registerBundledSkill()` + 内存注册表 |
| `src/skills/loadSkillsDir.ts` | 磁盘加载 + 动态发现 + 条件激活 |
| `src/skills/mcpSkillBuilders.ts` | MCP skill 构建器注册 |
| `src/tools/SkillTool/SkillTool.ts` | Skill 工具实现（validate / checkPermissions / call） |
| `src/tools/SkillTool/prompt.ts` | Skill 工具 prompt + 列表预算与格式化 |
| `src/tools/SkillTool/constants.ts` | `SKILL_TOOL_NAME = 'Skill'` |
| `src/commands.ts` | `getCommands()` / `getSkillToolCommands()` 聚合层 |
| `src/constants/prompts.ts` | System prompt 中 skill 相关指导语 |
| `src/utils/processUserInput/processSlashCommand.tsx` | 斜杠命令展开 |
| `src/utils/skills/skillChangeDetector.ts` | 文件监听热重载 |
| `src/bootstrap/state.ts` | `addInvokedSkill()` 压缩保留 |
| `src/utils/hooks/registerSkillHooks.ts` | Skill hooks 注册 |
