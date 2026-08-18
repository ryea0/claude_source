# Claude Code 多 Agent 交互机制

本文档梳理 Claude Code 中多 agent 系统的整体架构、交互方式与协作机制，并给出完整的端到端链路。

---

## 〇、一句话结论

Claude Code 里并存着**三套**多 agent 机制，协作能力逐级增强：

| 机制 | 角色关系 | 通信方式 | 有无互相协作 |
|---|---|---|---|
| **① Agent 工具**（subagent） | 主 agent → 子 agent（单向委托） | 函数返回值 / 消息队列 | ❌ 无（子 agent 彼此不认识） |
| **② Swarm / Agent Teams**（teammate） | leader ↔ N 个 teammate | **文件 mailbox**（双向） | ✅ 真正的双向协作 |
| **③ Coordinator 模式**（tengu） | coordinator → workers | ① 的 Agent + SendMessage 拼装 | ⚠️ 半协作（靠提示词编排） |

真正回答「有没有互相协作」：**只有开了 Agent Teams（swarm）才是真协作**；平时用的 Agent 工具本质是「派活收结果」的委托。

---

## 一、全景架构

```
触发层：AgentTool(/agent) · TeammateTool · coordinator 系统提示词
   │
   ├─ 无 team_name+name ──→ 普通 subagent ──→ 同步 runAgent 或 异步 LocalAgentTask
   │
   └─ 有 team_name+name ──→ spawnTeammate() ──→ 后端三选一
                                     │
                     ┌───────────────┼────────────────┐
                in-process       tmux 窗格        iTerm2 窗格
              (同进程, ALS)   (PaneBackendExecutor 适配)
                     │
          ┌──────────┴─────────────┐
          │  统一 Task 状态机        │  LocalAgentTask / InProcessTeammateTask /
          │  (AppState.tasks)       │  RemoteAgentTask / DreamTask / LocalMainSessionTask
          └────────────────────────┘
```

三套机制、四种执行后端、五种任务类型，通过「统一 Task 接口」和「统一 TeammateExecutor 接口」解耦（`src/tasks.ts:22-31` 注册任务，`src/utils/swarm/backends/registry.ts:425` 返回统一执行器）。

---

## 二、机制一：Agent 工具 —— 一次性「委托」

最常用、最基础的一层。核心文件 `src/tools/AgentTool/`。

### 2.1 子 agent 完整生命周期

```
AgentTool.call()                          AgentTool.tsx:239
  │
  ├─【选 agent】                            AgentTool.tsx:318-356
  │    ├─ 显式 subagent_type → 查 activeAgents 选中定义
  │    ├─ 省略 + fork 实验开 → fork 路径（FORK_AGENT）
  │    └─ 省略 + fork 关   → 默认 general-purpose
  │
  ├─【构造 prompt】                          AgentTool.tsx:483-541
  │    ├─ fork 路径: 继承父已渲染 system prompt 字节 + buildForkedMessages()
  │    └─ 普通路径: selectedAgent.getSystemPrompt() + [createUserMessage(prompt)]
  │
  ├─【组装 runAgent 参数】                    AgentTool.tsx:603-636
  │    workerTools = assembleToolPool(按子 agent 自己的 permissionMode 装配)
  │
  ├─【同步 vs 异步分流】
  │    ├─ 异步: registerAsyncAgent()          AgentTool.tsx:686-764
  │    │         → LocalAgentTask → 立即返回 {status:'async_launched', agentId}
  │    │
  │    └─ 同步: registerAgentForeground()     AgentTool.tsx:765-1261
  │              → while(true) 消费 runAgent 消息流 → finalizeAgentTool()
  │
  └─【runAgent 生成器】                      runAgent.ts:248
       ├─ getAgentModel()                     :340  解析模型
       ├─ createAgentId()                     :347  生成 agentId
       ├─ filterIncompleteToolCalls()         :368  fork context 处理
       ├─ agentGetAppState()                  :416  权限覆盖（permissionMode/allowedTools）
       ├─ resolveAgentTools()                 :500  工具解析（useExactTools 则继承父池）
       ├─ abortController                     :524  异步独立 / 同步共享父
       ├─ executeSubagentStartHooks + 技能预载 + 专属 MCP   :532-656
       ├─ createSubagentContext()             :700  隔离上下文
       ├─ query() 核心 tool loop              :748
       │     while(true){ callModel → tool_use → runTools → push tool_result → 重复 }
       │     直到模型不再请求工具
       └─ finally 清理                        :816  MCP/hooks/cache/fileState/todos
```

### 2.2 结果如何传回主 agent

| 场景 | 机制 | 关键代码 |
|---|---|---|
| 同步子 agent | `finalizeAgentTool()` 取最后一条文本 → 作为 **tool_result 直接返回** | `agentToolUtils.ts:276`, `AgentTool.tsx:1298` |
| 异步子 agent | `enqueueAgentNotification()` 构造 `<task-notification>` XML → 塞进消息队列 → 主循环 `print.ts:2015` 作为 **user 角色消息**喂给主模型 | `LocalAgentTask.tsx:197`, `print.ts:1934-2094` |
| 继续对话 | 运行中 `queuePendingMessage()`；已停止 `resumeAgentBackground()` 从磁盘 transcript 恢复 | `SendMessageTool.ts:810-872`, `resumeAgent.ts:42` |
| 磁盘持久化 | `recordSidechainTranscript()` 写入 `subagents/{agentId}/`，供 resume/SDK 面板用 | `runAgent.ts:735-742` |

### 2.3 递归（孙 agent）限制

子 agent 能否再 spawn 孙 agent 取决于用户类型（`constants/tools.ts:36-46`）：

- **普通外部用户**：`Agent` 工具进 `ALL_AGENT_DISALLOWED_TOOLS`，`filterToolsForAgent()` 从子 agent 工具池剔除 → **不能嵌套**。
- **Ant（内部）用户**：不禁用 Agent → 支持嵌套 agent。
- **fork 子 agent**：`useExactTools:true` 继承父完整工具池（含 Agent），但 `AgentTool.tsx:332` 有递归 fork 守卫禁止再 fork。

### 2.4 fork 与 resume

- **fork**（`forkSubagent.ts`）：省略 `subagent_type` 时隐式走。子 agent 继承父完整上下文与 system prompt 字节，用「相同占位 tool_result」技巧让所有 fork 子请求前缀一致、命中 prompt cache。
- **resume**（`resumeAgent.ts:42`）：agent 被停后，`SendMessage({to: agentId})` 从磁盘 transcript 重建上下文继续跑，复用 `runAgent`。

### 2.5 内置 agent

| agent | 定位 | 工具/模型 |
|---|---|---|
| `general-purpose` | 通用默认 | 全工具 `*` |
| `explore` | 只读代码库搜索 | 禁 Edit/Write/Agent，haiku |
| `plan` | 架构规划 | 同 explore，inherit |
| `statusline-setup` | 配状态栏 | Read+Edit |
| `verification` | 对抗性验证 | 禁写工具，输出 VERDICT |
| `claude-code-guide` | 回答 Claude 文档 | Bash/Read/WebFetch/Search，dontAsk |

---

## 三、机制二：Swarm / Agent Teams —— 真正的「互相协作」

代码量最大（`utils/swarm/` ~7000 行 + `teammateMailbox.ts`）。核心设计一句话：**「文件系统就是通信总线」**。

### 3.1 身份与团队文件

- 每个 agent 有确定性 ID `agentName@teamName`（`utils/agentId.ts:38`）。
- 团队元数据存 `~/.claude/teams/{team}/config.json`（`teamHelpers.ts:64`）：成员名册、`leadAgentId`、每个成员的 `mode/isActive/color/worktreePath/tmuxPaneId`、`teamAllowedPaths`（全队免审批路径）。
- **leader** = 创建团队的会话；`isTeamLead()`（`teammate.ts:171`）对比自己的 agentId 与 leadAgentId。用户只跟 leader 对话。
- 身份解析优先级：AsyncLocalStorage（in-process）> CLI 参数（tmux）> 环境变量（`teammate.ts:88`）。

### 3.2 邮箱通信（协作核心：文件即消息队列）

每个 agent 有一个 inbox 文件 `~/.claude/teams/{team}/inboxes/{name}.json`。发消息 = 给对方的 inbox 追加一条 JSON（proper-lockfile 加锁防并发，`teammateMailbox.ts:134`）。

协作动作 = **`SendMessage` 工具**（`SendMessageTool.ts`）：`to: "researcher"` 私聊、`to: "*"` 广播、结构化协议消息。teammate 系统提示词追加（`teammatePromptAddendum.ts`）：*"Just writing a response in text is not visible to others — you MUST use the SendMessage tool."*

### 3.3 消息自动投递

- **teammate 侧**：`waitForNextPromptOrShutdown()`（`inProcessRunner.ts:689`）500ms 轮询自己的 inbox，优先级 **shutdown > leader 消息 > peer 消息**（leader 代表用户意图）。
- **leader 侧**：`useInboxPoller.ts` 1s 轮询，普通消息格式化成 `<teammate-message>` XML 作为**新 turn**提交给 leader 模型；忙时排队、空闲交付。

### 3.4 共享任务列表（拉取式分工）

团队共享 `~/.claude/tasks/{team}/`（Team = TaskList 一一对应）。teammate 空闲时拉取式认领（`inProcessRunner.ts:595-624`）：找 `pending` 且无 owner 且未阻塞的任务 → 认领 → `in_progress` → 完成后 `TaskUpdate` 标记 → 再认领下一个。

### 3.5 权限桥接（leader 是 teammate 的「权限代理」）

teammate 执行需授权的工具时，权限回到 leader/用户，两条路径（`permissionSync.ts` + `leaderPermissionBridge.ts`）：

- **in-process**：直接把 `ToolUseConfirm`（带 `workerBadge`）塞进 leader 确认队列，弹同样 UI；批准后 `permissionUpdates` 写回共享权限上下文（`inProcessRunner.ts:223-280`）。
- **tmux 进程外**：`permission_request` 结构化消息写进 leader inbox → `useInboxPoller` 路由到确认 UI → `permission_response` 写回 teammate inbox → 回调继续。

worker 发起侧入口 `swarmWorkerHandler.ts:40`（先试 bash classifier 自动审批）。

### 3.6 结构化协议消息

mailbox 里流转的不只是自然语言，还有整套协议（`teammateMailbox.ts:1073`），`useInboxPoller` 路由到专门处理器而不当普通文本塞给模型：

| 消息 | 方向 | 用途 |
|---|---|---|
| `permission_request/response` | worker↔leader | 工具权限 |
| `sandbox_permission_*` | worker↔leader | 网络访问审批 |
| `plan_approval_request/response` | worker→leader | 计划审批 |
| `shutdown_request/approved/rejected` | 双向 | 优雅关机握手 |
| `task_assignment` | — | 任务分配 |
| `team_permission_update` | leader→全队 | 广播权限规则 |
| `mode_set_request` | leader→teammate | 改权限模式 |
| `idle_notification` | teammate→leader | 空闲通知 |

### 3.7 生命周期协作

teammate 每完成一轮自动 idle，发 `idle_notification` 给 leader（`inProcessRunner.ts:569`，另有 Stop hook 兜底 `teammateInit.ts:98`）。关机走 `shutdown_request`→`approved`→leader kill pane + 移除成员 + unassign 任务（`useInboxPoller.ts:678`）。

### 3.8 执行后端（为什么有 4 种）

| 后端 | 实现 | 场景 |
|---|---|---|
| **in-process** | `InProcessBackend`（AsyncLocalStorage 隔离，共享 API/MCP） | 无终端依赖、非交互 `-p` 模式 |
| **tmux 窗格** | `TmuxBackend` + `PaneBackendExecutor` | tmux 内切窗格 / 外部自建 `claude-swarm` 会话 |
| **iTerm2 窗格** | `ITermBackend`（it2 CLI） | macOS iTerm2 原生 split |

选择逻辑（`registry.ts:136/351`）：`iTerm2 → tmux → in-process` 三层回退，保证任何环境都能用。teammate 以「可见独立终端窗格」呈现给用户，所以需适配不同终端。

### 3.9 开关：实验特性

`isAgentSwarmsEnabled()`（`agentSwarmsEnabled.ts:24`）：内部 `USER_TYPE=ant` 恒开；外部需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`（或 `--agent-teams`）+ GrowthBook killswitch `tengu_amber_flint` 双门槛。

---

## 四、机制三：Coordinator 模式 —— 用「提示词」编排 worker

`coordinator/coordinatorMode.ts` 基本是一份 ~300 行的系统提示词（`getCoordinatorSystemPrompt()`，`:111`）。开启后主 agent 变成「coordinator」，职责被重写为调度者：

- 用 `Agent` 工具 spawn `subagent_type: "worker"` 的工人
- 用 `SendMessage`「续跑」已完成的 worker（利用其上下文）
- 用 `TaskStop` 停掉跑偏的 worker
- worker 结果以 `<task-notification>` XML 作为 user 消息回来

工作流四阶段：**Research（工人并行）→ Synthesis（coordinator 亲自做）→ Implementation（工人）→ Verification（工人独立验证）**。核心纪律「理解不能外包」——coordinator 必须自己读懂调研结果，再写带文件路径/行号的 spec 派给工人。

**本质**：没有新原语，用提示词工程把「Agent + SendMessage + TaskStop」编排成协作范式。并行 fan-out 由 `toolOrchestration.ts:91` 支撑（同一消息里多个 tool_use：只读并发、写串行）。

---

## 五、任务类型全景（5 种，`src/tasks/`）

| 任务 | 是什么 | 通信 |
|---|---|---|
| **LocalAgentTask** | Agent 工具的异步后台 subagent | 消息队列（task-notification XML） |
| **InProcessTeammateTask** | swarm 的进程内 teammate（tmux teammate 也注册此形状任务仅供 UI 追踪） | mailbox |
| **RemoteAgentTask** | Claude.ai 云端环境（CCR）的后台任务 | 不走 mailbox，走 teleport API 轮询事件流 |
| **DreamTask** | auto-dream 记忆整合 fork agent 的纯 UI 壳 | forkedAgent |
| **LocalMainSessionTask** | Ctrl+B 两次把主会话查询后台化 | 复用 local_agent |

### 5.1 RemoteAgentTask ——「远程」是 Claude.ai 云端

**「远程」指的不是另一台本地机器，而是 Claude.ai 云端代码环境（CCR）**。本地客户端通过 API 在云端拉起一个会话，然后本地轮询其事件流（`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`）。

- Task 实现 `RemoteAgentTask`（`:808`），`kill` 会 `archiveRemoteSession`（`:841`）释放云资源。
- 注册 `registerRemoteAgentTask`（`:386`），任务类型 `REMOTE_TASK_TYPES = ['remote-agent','ultraplan','ultrareview','autofix-pr','background-pr']`（`:60`）。
- 轮询 `startRemoteSessionPolling`（`:538`）每 1s 调 `pollRemoteSessionEvents(sessionId, lastEventId)`（`:564`），把新事件追加到本地输出文件。
- 完成判定钩子 `registerCompletionChecker(remoteTaskType, checker)`（`:84`）——不同任务类型注册各自「何时算完成」。
- 恢复 `restoreRemoteAgentTasks`（`:477`）——`--resume` 时从 sidecar 读元数据重建任务。
- **通信不走 mailbox**，走 Claude.ai/teleport API（`fetchSession`/`pollRemoteSessionEvents`/`archiveRemoteSession`，`src/utils/teleport*`），通知通过 `<task-notification>` XML 注入消息队列。

### 5.2 DreamTask —— 后台「梦想」记忆整合的 UI 壳

**本质是 auto-dream 记忆整合 fork agent 的纯 UI 壳**，本身不跑 agent（`DreamTask.ts:1-4` 注释明说 "the dream agent itself is unchanged — this is pure UI surfacing"）。

- 真正的 dream agent 是 `runForkedAgent`（`forkedAgent.ts:489`）fork 出来的记忆整合循环；DreamTask 只展示它的进度（phase、filesTouched、turns）。
- `kill`（`DreamTask.ts:136`）会 `rollbackConsolidationLock(priorMtime)` 回滚整合锁，让下一会话可重试。
- pill 显示 `dreaming`。

---

## 六、完整端到端链路

### 6.1 委托链路（Agent 工具）

```
用户输入
  ▼
主 agent queryLoop()                           query.ts:219
  ▼
模型输出 tool_use: { name: "Agent", input: { subagent_type, prompt } }
  ▼
runTools() → toolOrchestration.partitionToolCalls()
  │   同一消息多个 tool_use：只读并发 / 写串行（fan-out 支撑）
  ▼
AgentTool.call()                               AgentTool.tsx:239
  ├─ 无 team_name+name → runAgent()            runAgent.ts:248
  │    └─ query() tool loop → 工具执行 → 最终文本
  │         ├─ 同步: finalizeAgentTool() → tool_result 返回主 agent
  │         └─ 异步: registerAsyncAgent() → LocalAgentTask
  │              └─ 完成 → enqueueAgentNotification()
  │                   └─ <task-notification> XML → print.ts 作为 user 消息
  │                        └─ 主 agent 下一轮看到结果
  └─ 有 team_name+name → spawnTeammate()        spawnMultiAgent.ts:1088
```

### 6.2 协作链路（Swarm / Agent Teams）

```
leader 调用 TeamCreate                         TeamCreateTool.ts:128
  ▼
写团队文件 ~/.claude/teams/{team}/config.json   teamHelpers.ts:177
  ▼
leader 调用 Agent({ team_name, name }) → spawnTeammate()
  ▼
registry.isInProcessEnabled()                  registry.ts:351
  ├─ in-process → InProcessBackend.spawn() → startInProcessTeammate()
  │                └─ runInProcessTeammate()    inProcessRunner.ts:883
  └─ pane → TmuxBackend/ITermBackend 建窗格
             └─ 构造 cd+env claude --agent-id ... 命令发到窗格
                  └─ mailbox 写初始 prompt      PaneBackendExecutor.ts:178
  ▼
teammate 启动 → useSwarmInitialization()         useSwarmInitialization.ts
  ├─ 恢复/fresh 判定 → initializeTeammateHooks() teammateInit.ts:28
  │    ├─ 应用 teamAllowedPaths 到会话权限
  │    └─ 注册 Stop hook → idle 通知 leader
  └─ 身份解析（AsyncLocalStorage / CLI args / env）  teammate.ts:88
  ▼
teammate 运行主循环 runInProcessTeammate()
  ├─ waitForNextPromptOrShutdown() 500ms 轮询 inbox   :689
  │    优先级: shutdown > leader > peer
  ├─ tryClaimNextTask() 拉取式认领共享任务            :624
  ├─ 收到消息 → <teammate-message> XML 注入上下文
  ├─ 需要权限 → swarmWorkerHandler → leaderPermissionBridge / mailbox
  └─ 一轮结束 → idle_notification 发给 leader          :569
  ▼
leader 侧 useInboxPoller() 1s 轮询                 useInboxPoller.ts
  ├─ 普通消息 → 格式化成 XML → 作为新 turn 提交
  ├─ permission_request → 路由到确认 UI → 批复回 worker
  ├─ shutdown_approved → kill pane + 移除成员 + unassign 任务
  └─ idle_notification → 判断谁空闲可派新活
  ▼
任务完成 → leader 发 shutdown_request → 优雅关机 → cleanupSessionTeams()
```

### 6.3 结果回流三种形态

| 形态 | 载体 | 接收方 |
|---|---|---|
| 同步 subagent 结果 | tool_result 文本 | 主 agent 当前轮 |
| 异步 subagent/远程 agent 结果 | `<task-notification>` XML（user 消息） | 主 agent 下一轮 |
| teammate 消息 | mailbox `<teammate-message>` XML | leader 新 turn |

---

## 七、直接回答：有互相协作吗？

- **普通 Agent 工具**（日常最常用）→ **没有协作**。主从委托，子 agent 干完活交文本结果，彼此不认识、不通信。
- **Agent Teams / swarm**（实验特性）→ **有真正的互相协作**：队友之间用文件 mailbox 双向发消息（DM/广播）、共享任务列表拉取式分工、通过权限/关机/计划审批等结构化协议协调，leader 与 teammate 有明确「leader = 用户代理」的角色分工。
- **Coordinator 模式** → 介于两者之间，靠提示词 + SendMessage 在委托基础上模拟出协作。

**技术上最精妙的一点**：这套协作的通信总线既不是内存队列、也不是网络 socket，而是**加锁的 JSON 文件 + 轮询**——`~/.claude/teams/{team}/inboxes/{name}.json` 就是每个 agent 的「邮箱」，1s/500ms 的轮询就是「推送」。这种设计天然跨进程（tmux/iTerm 独立进程）也能单进程内（AsyncLocalStorage）复用。

---

## 八、关键文件速查

| 关注点 | 文件:行 |
|---|---|
| Agent 工具入口/分流 | `tools/AgentTool/AgentTool.tsx:239/284` |
| 子 agent 运行循环 | `tools/AgentTool/runAgent.ts:248` → `query.ts:307` |
| 结果回传（同步/异步） | `agentToolUtils.ts:276` / `tasks/LocalAgentTask/LocalAgentTask.tsx:197` + `cli/print.ts:2015` |
| 邮箱通信 | `utils/teammateMailbox.ts:134`（写）、`:56`（路径）、`:1073`（协议消息判定） |
| 团队文件/名册 | `utils/swarm/teamHelpers.ts:64` |
| 消息投递轮询 | `hooks/useInboxPoller.ts`（leader）、`utils/swarm/inProcessRunner.ts:689`（teammate） |
| 权限桥接 | `utils/swarm/permissionSync.ts`、`utils/swarm/leaderPermissionBridge.ts`、`hooks/toolPermission/handlers/swarmWorkerHandler.ts:40` |
| 后端选择 | `utils/swarm/backends/registry.ts:136/351/425` |
| 协调器提示词 | `coordinator/coordinatorMode.ts:111` |
| 统一 spawn | `tools/shared/spawnMultiAgent.ts:1088` |
| 工具编排（fan-out） | `services/tools/toolOrchestration.ts:19/91` |
| 远程 agent | `tasks/RemoteAgentTask/RemoteAgentTask.tsx:808/538` |
| 梦想记忆整合 | `tasks/DreamTask/DreamTask.ts:132`、`utils/forkedAgent.ts:489` |
| fork / resume | `tools/AgentTool/forkSubagent.ts:60/107`、`tools/AgentTool/resumeAgent.ts:42` |
| 开关 | `utils/agentSwarmsEnabled.ts:24` |
| 身份 ID | `utils/agentId.ts:38`、`utils/agentContext.ts` |
