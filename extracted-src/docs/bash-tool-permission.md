# Bash 工具权限判定、人机确认与执行完整链路

本文档梳理 Claude Code 中 **Bash 工具**从「模型发起 tool_use」到「权限判定」「人机确认」「真正执行」的完整生命周期，并展开四块核心子系统的细节：

1. 只读判定 `checkReadOnlyConstraints`
2. 路径约束 `checkPathConstraints`
3. 沙箱（`shouldUseSandbox` / `SandboxManager`）与权限的交互
4. auto 模式分类器（`classifyYoloAction`）自动批准

> 源码位于 `extracted-src/src/`（下文以 `src/` 代指）。这些 `.tsx` 文件是 React Compiler 编译产物，变量名被混淆，但每个文件末尾都带 `sourcesContent` 可还原原始源码。

---

## 第一部分：总体链路

```
模型输出 tool_use(Bash)
  → services/tools/toolExecution.ts        工具执行编排
    → runPreToolUseHooks                      PreToolUse Hook
    → resolveHookPermissionDecision(toolHooks.ts:332)
      → canUseTool = useCanUseTool 封装的 hasPermissionsToUseTool
        → checkRuleBasedPermissions          (permissions.ts:1071)
          → BashTool.checkPermissions = bashToolHasPermission (纯判定)
            → 返回 allow / deny / ask / passthrough
        → 若 "ask" → handleInteractivePermission 压入确认队列
          → UI: PermissionRequest → BashPermissionRequest (人机确认弹窗)
          → 用户选 Yes/No → onAllow/onReject → resolve Promise → 回传 decision
    → 若 allow → BashTool.call → runShellCommand → exec(...) 真正执行 bash
```

### 1.1 工具执行入口 `toolExecution.ts`

`streamedCheckPermissionsAndCallTool`(`toolExecution.ts:492`)是每个工具被调用时的执行器，核心顺序：

1. 先跑 **PreToolUse Hook**(`runPreToolUseHooks`,`toolExecution.ts:797` 附近)，产出 `hookPermissionResult`。
2. 调 `resolveHookPermissionDecision`(`toolHooks.ts:332`)融合 hook 结果与规则判定：
   - hook `allow` 且工具**不**需交互 → 直接放行（deny/ask 规则仍可覆盖）；
   - hook `deny` → 直接 deny；
   - 否则走 `canUseTool`(`toolHooks.ts:423`)。
3. `canUseTool` 返回 `permissionDecision`，若 `behavior !== 'allow'`(`toolExecution.ts:995`)则生成 `is_error: true` 的 `tool_result` 反馈给模型，不再执行；`allow` 才继续到 `BashTool.call`。

### 1.2 `canUseTool` = `hasPermissionsToUseTool`（`permissions.ts:473`）

内部先走 `hasPermissionsToUseToolInner`(`permissions.ts:1158`)，判定顺序：

| 步骤 | 检查项 | 结果 |
|---|---|---|
| 1a | 整个工具被 deny 规则命中 | deny |
| 1b | 整个工具有 ask 规则（沙箱自动放行除外） | ask |
| 1c | `tool.checkPermissions`（Bash 核心判定） | deny/ask/allow/passthrough |
| 1d | 工具实现判定 deny | deny |
| 1e | `requiresUserInteraction` 且 ask | ask |
| 1f | 内容级 ask 规则（如 `Bash(npm publish:*)`） | ask（绕过 bypass） |
| 1g | safetyCheck（如 `.git/` `.claude/`） | ask（绕过 bypass） |
| 2a | bypassPermissions / plan+bypass 模式 | allow |
| 2b | 工具始终允许规则 `toolAlwaysAllowedRule` | allow |
| 3 | `passthrough` → `ask` | ask |

之后 `hasPermissionsToUseTool`(`permissions.ts:503`)做尾部变换：

- `dontAsk` 模式 → `ask` 直接变 `deny`；
- `auto` 模式 + `TRANSCRIPT_CLASSIFIER` → 交给 AI 分类器（见第五部分）。

### 1.3 Bash 核心判定 `bashToolHasPermission`（`bashPermissions.ts:1663`）

判定顺序（详见下文各章节）：

1. **tree-sitter AST 安全解析**(`:1688-1806`)：`too-complex` → 尊重 deny 规则否则 ask；`simple` → `checkSemantics`(拦 `eval` 等)；`parse-unavailable` → 回退 legacy。
2. **沙箱自动放行**(`:1829-1843`)：`checkSandboxAutoAllow`。
3. **精确匹配规则**(`:1846-1854`)：`bashToolCheckExactMatchPermission`。
4. **Prompt 型 deny/ask 规则**(`:1859-1971`)：并行跑 Haiku 分类器。
5. **操作符权限**(`:1976-2076`)：管道 `|`、重定向 `>`。
6. **Legacy 误解析闸门**(`:2085-2142`)：`bashCommandIsSafeAsync`。
7. **拆分子命令**(`:2144-2157`)：`splitCommand`/AST + `filterCdCwdSubcommands`。
8. **特殊组合拦截**：多 `cd` → ask(`:2182`)；`cd`+`git` → ask(`:2209`)。
9. **逐子命令 `bashToolCheckPermission`**(`:2239-2246`)：任一 deny → 整体 deny。
10. **原始命令重定向路径校验**(`:2276-2286`)。
11. **汇总**(`:2288-2557`)：allow/ask/passthrough + 规则建议。

`bashToolCheckPermission`（单条子命令，`bashPermissions.ts:1050`）内部顺序：精确匹配 → 前缀 deny/ask → 路径约束 → 精确 allow → 前缀 allow → sed 约束 → 模式 → 只读放行 → passthrough。

### 1.4 人机确认的实现

- **`useCanUseTool`**（`hooks/useCanUseTool.tsx:28`）：把纯判定函数包成可阻塞的 Promise。`allow` → `resolve(buildAllow)`；`deny` → `resolve(result)`；`ask` → `handleInteractivePermission(...)`。
- **`handleInteractivePermission`**（`hooks/toolPermission/handlers/interactiveHandler.ts:57`）：把 `ToolUseConfirm` 压入队列(`:92`)，挂 `onAllow`(`:154`)→ `ctx.handleUserAllow` 持久化规则并 allow、`onReject`(`:183`)→ `ctx.cancelAndAbort`、`onAbort`(`:137`)、`recheckPermission`(`:204`)。同时用 `claim()` 保证多个异步竞速者谁先到谁赢：
  - Bridge/CCR(claude.ai) 确认弹窗(`:244`)
  - Channel(Telegram 等) 手机端(`:316`)
  - PermissionRequest Hook(`:410`)
  - Bash 分类器自动批准(`:434`)
- **UI 渲染**：队列在 `components/Messages.tsx` 渲染 `PermissionRequest`(`components/permissions/PermissionRequest.tsx:146`)，`permissionComponentForTool`(`:47`)把 `BashTool → BashPermissionRequest`。
- **用户操作 → 规则持久化**：`ctx.handleUserAllow`(`PermissionContext.ts:291`)→ `persistPermissions`(`:139`)→ `persistPermissionUpdates` 写盘 + `applyPermissionUpdates` 更新内存 `ToolPermissionContext`。

### 1.5 执行 `BashTool.call`（`BashTool.tsx:624`）

`runShellCommand`(`BashTool.tsx:826`)→ `exec(command, signal, 'bash', { timeout, onProgress, preventCwdChanges, shouldUseSandbox, shouldAutoBackground })`(`:881`)，支持超时自动转后台、进度流式回调、`interpretCommandResult` 结果语义判断、`trackGitOperations` 记录 git 操作。

---

## 第二部分：只读判定 `checkReadOnlyConstraints`

**入口**：`BashTool.isReadOnly`(`BashTool.tsx:437`)→ `checkReadOnlyConstraints`(`readOnlyValidation.ts:1876`)。它回答「这条命令是否可视为纯只读、从而免弹窗自动放行」。

### 2.1 主流程判定顺序

```
checkReadOnlyConstraints (readOnlyValidation.ts:1876)
  1. tryParseShellCommand 解析失败 → passthrough (不判定为只读)
  2. bashCommandIsSafe_DEPRECATED 不安全 → passthrough
  3. containsVulnerableUncPath (Windows UNC WebDAV) → ask
  4. commandHasAnyGit && isCurrentDirectoryBareGitRepo → passthrough  (bare 仓库防护)
  5. commandHasAnyGit && commandWritesToGitInternalPaths → passthrough (写 .git 内部再跑 git)
  6. compoundCommandHasCd && hasGitCommand → passthrough            (cd+git 沙箱逃逸防护)
  7. hasGitCommand && sandbox 开启 && cwd != 原始 cwd → passthrough (后台 git 竞态防护)
  8. splitCommand_DEPRECATED 后每个子命令：
       bashCommandIsSafe_DEPRECATED 安全 且 isCommandReadOnly(subcmd) 全为真
     → allow（只读自动放行）
  9. 否则 → passthrough（交给后续权限检查）
```

其中 `isCommandReadOnly`(`readOnlyValidation.ts:1678`)对每条子命令做：

1. 去掉末尾 ` 2>&1`（stderr 重定向）；
2. `containsVulnerableUncPath` → false；
3. `containsUnquotedExpansion`（未加引号的 glob `*?[]` 或 `$VAR`）→ false（防正则绕过）；
4. `isCommandSafeViaFlagParsing`（走 COMMAND_ALLOWLIST 白名单）→ true；
5. 命中 `READONLY_COMMAND_REGEXES` 手写正则 → 但若含 git 的 `-c` / `--exec-path` / `--config-env` 危险 flag → false；
6. 否则 false。

### 2.2 三条判定路径

**① 白名单 flag 解析 `isCommandSafeViaFlagParsing`(`readOnlyValidation.ts:1246`)**

针对 `COMMAND_ALLOWLIST`(`:128`)里逐命令定义的「安全 flag 集合」，做严格 token 级校验：

- 用 `tryParseShellCommand` 解析 token，含操作符（`|`、`>` 等）→ false；
- 多词命令优先匹配（如 `git diff`、`git stash list`）；
- `git ls-remote` 特判：拒绝 `://`、`@`、`:`、`$`（防数据外泄）；
- **拒绝任何含 `$` 的 token**（`:1328-1356`，防 `$VAR` 前缀/中缀绕过 `validateFlags` 与回调正则，注释里给了 `rg "$Z--pre=bash"` RCE 案例）；
- 拒绝含 `{`+`,` 或 `{`+`..` 的 token（brace 展开混淆）；
- `validateFlags` 校验每个 flag 类型与参数；
- 可选 `regex`、反引号拦截、`rg`/`grep` 换行拦截、`additionalCommandIsDangerousCallback`（如 `ps axe` 防 env 泄露）。

`COMMAND_ALLOWLIST` 覆盖 git 只读子命令、`rg`、`grep`、`xargs`（`-i`/`-e` 已因 GNU getopt 歧义被移除，改用 `-I {}`/`-E EOF`）等；`ANT_ONLY_COMMAND_ALLOWLIST`(`:1141`)追加 `gh` 只读子命令。来源在 `utils/shell/readOnlyCommandValidation.ts`（`GIT_READ_ONLY_COMMANDS`、`RIPGREP_READ_ONLY_COMMANDS`、`GH_READ_ONLY_COMMANDS` 等）。

**② 简单命令正则 `READONLY_COMMANDS`(`:1432`)**

跨平台 `EXTERNAL_READONLY_COMMANDS` + Unix 专属命令（`cal`、`uptime`、`cat`、`head`、`tail`、`wc`、`stat`、`id`、`uname`、`df`、`du`、`basename`、`dirname`、`diff`、`sleep`、`which`、`type`、`seq`…），经 `makeRegexForSafeCommand`(`:1422`)生成 `/^cmd(?:\s|$)[^<>()$`|{}&;\n\r]*$/` 阻断 shell 元字符。

**③ 复杂命令手写正则 `READONLY_COMMAND_REGEXES`(`:1509`)**

`echo`（禁变量/命令替换）、`claude -h/--help`、`uniq`（仅 flags）、`pwd`、`whoami`、`node -v`（精确锚定，防 `node -v --run`）、`history`、`alias`、`arch`、`ip addr`、`ifconfig`、`jq`（禁 `-f/--rawfile/--library-path/env/$ENV`）、`cd`、`ls`、`find`（禁 `-delete/-exec/-execdir/-ok/-fprint*`）等。

### 2.3 关键防护点

- **`containsUnquotedExpansion`(`:1600`)**：跟踪单/双引号状态，识别引号外的 glob 与 `$VAR`（`$` 后跟 `[A-Za-z_@*#?!$0-9-]`），因为无法静态得知展开结果就不能判定只读。特别注意单引号内 `\` 是字面量、不转义，避免引号状态失同步。
- **git 危险 flag 拦截**：`-c` / `--exec-path` / `--config-env`（可注入 `core.fsmonitor`、`diff.external`、`core.gitProxy` 等执行任意命令）。
- **bare 仓库防护**：`isCurrentDirectoryBareGitRepo` + `commandWritesToGitInternalPaths`（`HEAD`/`objects/`/`refs/`/`hooks/`）防「先造 git 内部文件再跑 git 触发恶意 hook」。
- **后台 git 竞态**：sandbox 开启且 cwd ≠ 原始 cwd 时不判定 git 只读，防 `sleep 10 && git status` 在子目录里被裸仓库 hook 利用。

---

## 第三部分：路径约束 `checkPathConstraints`

**入口**：`checkPathConstraints`(`pathValidation.ts:1013`)，在 `bashToolCheckPermission` 的步骤 3、以及 `bashToolHasPermission` 的步骤 10（原始命令重定向）被调用。

### 3.1 主流程

```
checkPathConstraints (pathValidation.ts:1013)
  1. 进程替换 >(cmd)/<(cmd) → ask          (命令能写文件但目标不可见)
  2. 提取输出重定向 (AST 优先，否则 extractOutputRedirections)
     hasDangerousRedirection (目标含 $VAR/%VAR%) → ask
     validateOutputRedirections  → deny/ask
  3. 逐子命令:
     AST 路径 → validateSinglePathCommandArgv
     否则    → validateSinglePathCommand (stripSafeWrappers → parseCommandArguments
              → 非 SUPPORTED_PATH_COMMANDS 则 passthrough → createPathChecker)
     任一 ask/deny → 返回
  4. 否则 → passthrough
```

### 3.2 受约束的路径命令

`SUPPORTED_PATH_COMMANDS`(`:511`)= `PATH_EXTRACTORS` 的键(`:190`)，共 36 个：`cd/ls/find/mkdir/touch/rm/rmdir/mv/cp/cat/head/tail/sort/uniq/wc/cut/paste/column/tr/file/stat/diff/awk/strings/hexdump/od/base64/nl/grep/rg/sed/git/jq/sha256sum/sha1sum/md5sum`。

`COMMAND_OPERATION_TYPE`(`:552`)定义每个命令的读写类型：`cd/ls/find/cat/head/.../grep/rg/git/jq` 等为 `read`；`mkdir/touch` 为 `create`；`rm/rmdir/mv/cp/sed` 为 `write`。

### 3.3 单条命令校验 `validateCommandPaths`(`:603`)

```
1. PATH_EXTRACTORS[command] 提取路径参数
2. COMMAND_VALIDATOR 命令级 flag 拦截:
     mv/cp 含任何 -flag → ask (防 --target-directory 绕过路径提取)
3. compoundCommandHasCd && operationType !== 'read' → ask (cd + 写操作，无法确定最终 cwd)
4. 对每个路径 validatePath → isPathAllowed:
     deny 规则 → deny
     不允许 → ask (附带建议: Read 规则 / addDirectories / acceptEdits 模式)
5. 全部合法 → passthrough
```

**路径提取细节**：

- `filterOutFlags`(`:126`)正确处理 POSIX `--` 结束选项分隔符，防 `rm -- -/../.claude/settings.local.json` 这类 `-` 开头路径被跳过校验。
- `parsePatternCommand`(`:142`)处理 `grep/rg` 的「pattern 后跟路径」语义（`-e/--regexp/-f/--file` 标记 pattern 已出现）。
- `checkDangerousRemovalPaths`(`:70`)在 `rm/rmdir` 上**额外**检查，且**不能被 allow 规则绕过**：目标是 `*`、`/*`、`/`、home 目录、根目录直接子目录（`/usr`、`/tmp`、`/etc`）、Windows 盘符根/子目录 → 强制 ask（`isDangerousRemovalPath`,`utils/permissions/pathValidation.ts:331`）。

### 3.4 路径是否允许 `isPathAllowed`(`utils/permissions/pathValidation.ts:141`)

对每个解析后的绝对路径，按顺序：

```
permissionType = read 操作 ? 'read' : 'edit'
1. deny 规则 (matchingRuleForInput) → 拒绝
2. (写/建) 内部可编辑路径 checkEditableInternalPath (plan 文件/scratchpad/agent memory/job 目录) → allow
2.5 (写/建) checkPathSafetyForAutoEdit (Windows 模式/Claude 配置/危险文件，含 symlink 解析) → 不安全则拒绝
3. pathInAllowedWorkingPath (在工作目录内)
     read 或 acceptEdits 模式 → allow
     写/建但非 acceptEdits → 继续往下
3.5 (读) checkReadableInternalPath (项目临时目录/session memory) → allow
3.7 (写/建且不在工作目录) isPathInSandboxWriteAllowlist → allow (沙箱可写白名单)
4. allow 规则 → allow
5. 否则 → 拒绝
```

### 3.5 工作目录边界 `pathInAllowedWorkingPath`(`filesystem.ts:683`)

- `allWorkingDirectories`(`:667`)= `getOriginalCwd()` ∪ `additionalWorkingDirectories`。
- 对输入路径与工作目录都做 **symlink 解析**（`getResolvedWorkingDirPaths` memoize）、macOS `/private/var` `/private/tmp` 归一、**大小写归一**（防 `.cLauDe/CoMmAnDs` 大小写绕过）。
- `pathInWorkingPath`(`:709`)用跨平台 `relativePath` 计算相对路径，含 `..` 穿越则拒绝，非绝对则视为目录内。

### 3.6 输出重定向校验 `validateOutputRedirections`(`:924`)

- `compoundCommandHasCd && 有重定向` → ask（`cd .claude/ && echo x > settings.json` 无法确定最终 cwd）；
- `/dev/null` 始终安全；
- 每个 `>` / `>>` 目标按 `create` 操作走 `validatePath`：deny 规则 → deny；否则 ask 并建议 `addDirectories`。

---

## 第四部分：沙箱与权限的交互

### 4.1 是否使用沙箱 `shouldUseSandbox`(`shouldUseSandbox.ts:130`)

```
shouldUseSandbox(input)
  SandboxManager.isSandboxingEnabled() === false → false
  input.dangerouslyDisableSandbox && areUnsandboxedCommandsAllowed → false
  input.command 为空 → false
  containsExcludedCommand(command) → false
  → true
```

`containsExcludedCommand`(`:21`)检查两类排除命令（**注释明确：这是用户体验便利，不是安全边界**）：

- ant 用户 GrowthBook 动态配置 `tengu_sandbox_disabled_commands`（`substrings` + `commands`）；
- settings 里的 `sandbox.excludedCommands`，对复合命令逐子命令、并剥 env var / wrapper（固定点迭代）后用 prefix/exact/wildcard 匹配。

### 4.2 `SandboxManager` 三大开关（`sandbox-adapter.ts`）

| 开关 | 位置 | 默认 | 含义 |
|---|---|---|---|
| `isSandboxingEnabled` | `:532` | 由 `sandbox.enabled` 决定 | 平台支持(macOS/Linux/WSL2) + 依赖(bubblewrap/socat) + `enabledPlatforms` + 用户开启 |
| `isAutoAllowBashIfSandboxedEnabled` | `:469` | `true` | `sandbox.autoAllowBashIfSandboxed`——沙箱下命令自动放行 |
| `areUnsandboxedCommandsAllowed` | `:474` | `true` | `sandbox.allowUnsandboxedCommands`——是否允许 `dangerouslyDisableSandbox` |

`getSandboxUnavailableReason`(`:562`)在用户显式开启但依赖缺失/平台不支持时给出可读原因（`/sandbox` 或 `/doctor` 排查）。

### 4.3 沙箱如何影响权限判定

**(a) 沙箱自动放行 `checkSandboxAutoAllow`(`bashPermissions.ts:1270`)**

当 `isSandboxingEnabled() && isAutoAllowBashIfSandboxedEnabled() && shouldUseSandbox(input)` 三者同时满足时，`bashToolHasPermission` 在精确匹配前就调用它(`:1829-1843`)：

```
1. 完整命令 deny/ask 规则（prefix 匹配）→ deny/ask
2. 复合命令逐子命令 deny → deny；子命令 ask 暂存
3. 完整命令 ask → ask
4. 无任何规则 → allow（"Auto-allowed with sandbox"）
```

即：**沙箱 + 自动放行开启时，命中任何 deny/ask 规则仍会拦截，否则直接 allow，跳过后续全部路径/只读检查**。

**(b) 普通模式下的沙箱写白名单**

`isPathAllowed` 步骤 3.7（`utils/permissions/pathValidation.ts:233`）：写/建操作目标**不在**工作目录但命中 `isPathInSandboxWriteAllowlist`（沙箱可写目录，如 `/tmp/claude/`）时允许，避免重定向/touch/mkdir 无谓弹窗。工作目录内路径被排除（防绕过 acceptEdits 门槛）。

**(c) git 只读判定的沙箱门槛**

`checkReadOnlyConstraints`(`readOnlyValidation.ts:1956`)：git 命令 + sandbox 开启 + cwd ≠ 原始 cwd → 不判定只读（防后台 git 在子目录被裸仓库 hook 利用）。

**(d) 执行时注解**

`BashTool.call` 中 `SandboxManager.annotateStderrWithSandboxFailures`(`BashTool.tsx:710`)把沙箱违规信息追加到输出，告知模型为何被沙箱拦截。

---

## 第五部分：auto 模式分类器自动批准

当 `toolPermissionContext.mode === 'auto'` 且 `feature('TRANSCRIPT_CLASSIFIER')` 时，`hasPermissionsToUseTool`(`permissions.ts:520`)不再弹窗，改用 AI 分类器代替人类审批。

### 5.1 auto 模式的决策链（`permissions.ts:520-927`）

```
result.behavior === 'ask' 且 mode === 'auto'
  0. safetyCheck 且不可分类器批准 → 保留 ask (免疫自动批准)
  1. requiresUserInteraction 工具 → 保留 ask
  2. PowerShell (非 POWERSHELL_AUTO_MODE) → 保留 ask/deny
  3. acceptEdits 快路径: 假设 mode=acceptEdits 重新 checkPermissions
       若 allow → allow (跳过分类器，省 API 调用)
  4. 安全工具白名单 isAutoModeAllowlistedTool → allow
  5. classifyYoloAction(分类器) →
       shouldBlock=false → allow (recordSuccess 重置连续拒绝)
       shouldBlock=true 且 transcriptTooLong → 回退手动提示
       shouldBlock=true 且 unavailable → iron_gate_closed 决定:
           fail-closed → deny ("Classifier unavailable")
           fail-open   → 回退手动提示
       shouldBlock=true → recordDenial → 若超拒绝上限 → 回退手动提示
                           否则 → deny (classifier: 'auto-mode')
  6. shouldAvoidPermissionPrompts (headless/后台 agent) → 跑 PermissionRequest Hook，无则 deny
```

### 5.2 分类器核心 `classifyYoloAction`(`yoloClassifier.ts:1012`)

```
1. buildToolLookup + toCompact(action)  —— action 为空则直接放行 (工具声明无安全相关输入)
2. buildYoloSystemPrompt(context)       —— 系统提示词(见 5.4)
3. buildTranscriptEntries(messages)     —— 把主对话历史压缩成 classifier 可读 transcript
4. buildClaudeMdMessage()               —— 可选 CLAUDE.md 作为 prefix 消息
5. userPrompt = transcript + actionCompact (action 块加 cache_control)
6. getClassifierModel() → 两阶段 XML 或单阶段工具调用:
     单阶段: sideQuery({ system, temperature:0, thinking, tools:[YOLO_CLASSIFIER_TOOL_SCHEMA],
             tool_choice:{type:'tool', name:'classify_result'} })
     两阶段: classifyYoloActionXml (Stage1 快速 <block> + Stage2 深思)
7. 解析工具调用 → { shouldBlock, reason, model, usage, durationMs, stage, ... }
```

分类器工具 schema(`yoloClassifier.ts:255-283`)强制输出 `{ thinking, shouldBlock, reason }`，`shouldBlock: true` 即拒绝。

**两阶段分类器**（`classifyYoloActionXml`,`:711`，GrowthBook `isTwoStageClassifierEnabled` 开启）：

- Stage 1（`XML_S1_SUFFIX` `:550`）：`"Err on the side of blocking. <block> immediately."`，快速保守决策；若 block 则直接返回。
- Stage 2（`XML_S2_SUFFIX` `:560`）：带 `<thinking>` 的深思，共享 stage1 的 transcript+action 前缀（cache 命中）。

### 5.3 快速路径与白名单

- **acceptEdits 快路径**（`permissions.ts:600`）：以 `mode='acceptEdits'` 重跑 `tool.checkPermissions`，若 allow 则跳过分类器（工作目录内的文件编辑等安全操作）。
- **安全工具白名单 `SAFE_YOLO_ALLOWLISTED_TOOLS`(`classifierDecision.ts:56`)**：`FileRead/Grep/Glob/LSP/ToolSearch/ListMcpResources/ReadMcpResource/TodoWrite/Task*/AskUserQuestion/EnterPlanMode/ExitPlanMode/TeamCreate/TeamDelete/SendMessage/Workflow/Sleep/TerminalCapture/YOLO_CLASSIFIER` 等**只读/元数据/协调**工具直接放行，不调分类器。写/编辑工具**不在**白名单内（走 acceptEdits 快路径或分类器）。
- **`formatActionForClassifier`(`yoloClassifier.ts:1487`)**：把待审动作格式化成 `{ role:'assistant', content:[{ type:'tool_use', name, input }] }` 作为 transcript 最后一条。

### 5.4 系统提示词 `buildYoloSystemPrompt`(`:484`)

`BASE_PROMPT` + 权限模板（外部权限 `EXTERNAL_PERMISSIONS_TEMPLATE` vs Anthropic `ANTHROPIC_PERMISSIONS_TEMPLATE`），再注入三类规则：

- `allow` 描述（Bash prompt allow 规则 + `autoMode.allow`）
- `deny` 描述（Bash prompt deny 规则 + PowerShell 拒绝指引 + `autoMode.soft_deny`）
- `environment` 描述（`autoMode.environment`）

用 `<user_allow_rules_to_replace>` / `<user_deny_rules_to_replace>` / `<user_environment_to_replace>` 占位符替换（外部模板是替换默认值，Anthropic 模板是追加）。

### 5.5 拒绝追踪与降级（`denialTracking.ts`）

| 常量 | 值 |
|---|---|
| `DENIAL_LIMITS.maxConsecutive`(`:13`) | 3 次连续拒绝 |
| `DENIAL_LIMITS.maxTotal`(`:14`) | 20 次总拒绝 |

- `recordDenial`(`:24`)：连续 +1、总 +1；
- `recordSuccess`(`:32`)：连续清零（成功一次即打破连拒）；
- `shouldFallbackToPrompting`(`:40`)：连续 ≥3 或总 ≥20 → 触发 `handleDenialLimitExceeded`(`permissions.ts:984`)回退到**手动提示**，让用户 review transcript。

### 5.6 分类器失败语义

- `unavailable`（API 错误）→ 由 GrowthBook `tengu_iron_gate_closed`（默认 true）决定 **fail-closed（deny）** 还是 **fail-open（回退手动提示）**；
- `transcriptTooLong`（超出分类器上下文窗口）→ 永久性错误，headless 下直接 abort，交互下回退手动提示；
- 无 tool_use block → 解析失败 → `shouldBlock: true`（安全起见拒绝）。

---

## 附录：关键文件索引

| 关注点 | 文件 |
|---|---|
| Bash 工具定义/执行 | `src/tools/BashTool/BashTool.tsx` |
| Bash 权限判定主流程 | `src/tools/BashTool/bashPermissions.ts` |
| 只读判定 | `src/tools/BashTool/readOnlyValidation.ts` |
| 路径约束（Bash） | `src/tools/BashTool/pathValidation.ts` |
| 路径允许判定（通用） | `src/utils/permissions/pathValidation.ts` |
| 工作目录边界 | `src/utils/permissions/filesystem.ts` |
| 模式逻辑 | `src/tools/BashTool/modeValidation.ts` |
| 沙箱判定 | `src/tools/BashTool/shouldUseSandbox.ts` |
| 沙箱管理器 | `src/utils/sandbox/sandbox-adapter.ts` |
| 通用权限判定 | `src/utils/permissions/permissions.ts` |
| 工具调用编排/权限接入 | `src/services/tools/toolExecution.ts`、`toolHooks.ts` |
| 人机确认 hook 封装 | `src/hooks/useCanUseTool.tsx` |
| 交互确认/竞速 | `src/hooks/toolPermission/handlers/interactiveHandler.ts` |
| 队列与规则持久化 | `src/hooks/toolPermission/PermissionContext.ts` |
| UI 弹窗 | `src/components/permissions/PermissionRequest.tsx`、`.../BashPermissionRequest/` |
| auto 模式分类器 | `src/utils/permissions/yoloClassifier.ts` |
| 分类器安全白名单 | `src/utils/permissions/classifierDecision.ts` |
| 拒绝追踪 | `src/utils/permissions/denialTracking.ts` |
| 只读命令清单（共享） | `src/utils/shell/readOnlyCommandValidation.ts` |
