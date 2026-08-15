# MyAgent - 个人智能 Agent 系统

基于 Pi-mono 框架的个人智能 Agent 系统，支持对话交互和自主代码生成/执行（类似 OpenCode 能力），前后端分离，接入本地部署的 Qwen 大模型。支持网页版（Express + SSE）与桌面客户端（Electron + AgentEngine）两种形态。

> **开源许可**：本项目基于 [MIT 许可](LICENSE) 开源，构建于 [pi-mono](https://github.com/earendil-works/pi-mono)（`@earendil-works/pi-agent-core` / `pi-ai`，MIT）之上。

## 项目结构

```
my-Agent/
├── backend/                # Express + TypeScript 后端（ESM）
│   ├── src/
│   │   ├── agent/          # Agent 核心（agent-factory 权限门控、LLM 配置、消息转换、模型适配）
│   │   ├── agent-engine/   # 客户端 Agent 引擎（Electron 主进程复用，esbuild 单文件）
│   │   ├── services/       # agent-service（会话编排/自动压缩）、session-manager、
│   │   │                   # session-jsonl（导入导出）、memory-service（跨会话记忆）、
│   │   │                   # skills-loader（技能）、extension-loader、mcp-bridge、token-tracker
│   │   ├── tools/          # 11 个自定义工具（read/write/edit/grep/list/execute/search/run_python/run_skill/remember/subagent）
│   │   ├── config/         # tool-permission-config（allow/ask/deny）、rate-limit-config
│   │   ├── routes/         # API 路由（chat、execute、session、abort、config、confirmation、
│   │   │                   # memory、token、steer、sync、utils）
│   │   ├── middleware/     # 错误处理、请求日志
│   │   ├── confirmation/   # 工具调用待确认队列
│   │   ├── auth/ admin/ db/ rpc/ ws/ utils/
│   └── tests/unit/         # node:test 单元测试（memory / tools / permissions）
├── frontend/               # React + Vite + TypeScript 前端
│   ├── src/
│   │   ├── components/     # 26 个 UI 组件（chat / agent / auth / common / input / layout）
│   │   ├── services/       # API 调用、SSE/WS 客户端
│   │   ├── store/          # Zustand 状态管理（chat-store、auth-store）
│   │   └── types/          # TypeScript 类型定义
├── build/                  # Electron 打包产物（dist/agent-engine.mjs、主进程等）
├── data/                   # 运行时数据（myagent.db、rate-limit-config.json、
│                           # tool-permissions.json、memory.md，均按需自动创建）
├── extensions/             # Agent 扩展（扩展工具加载）
├── mcp/                    # MCP 服务端（my-mcp-server）
└── .pi/skills/             # Agent 技能定义
```

## 技术栈

- **后端**: Node.js 22+、Express 5、TypeScript（ESM）、pi-mono（@earendil-works/pi-agent-core + pi-ai）、esbuild（打包）、node:test（测试）
- **前端**: React 19、Vite 6、Zustand 5、TypeScript
- **大模型**: 本地 Qwen（LM Studio 部署，OpenAI 兼容 API）
- **通信**: RESTful API + Server-Sent Events（SSE），Electron 客户端经 WebSocket/RPC 与主进程通信

## 快速启动

### 前置条件

1. Node.js 22+
2. 一个 OpenAI 兼容的 LLM 服务（如本地 Qwen 部署于 `http://localhost:1234/v1`，或云端 DeepSeek；可用 `.env` 或前端设置页配置）

### 启动后端

```bash
cd backend
npm install
npm run dev        # tsx watch src/index.ts
```

服务运行在 `http://localhost:7980`（默认端口，可用 `PORT` 环境变量覆盖）。

### 启动前端

```bash
cd frontend
npm install
npx vite
```

前端运行在 `http://localhost:5173`，已配置代理将 `/api` 请求转发到后端。

### 运行测试

```bash
cd backend
npm test           # node --import tsx --test tests/unit/*.test.ts（零新增依赖）
```

### 构建

```bash
# 后端正式产物（backend/dist/index.js）
cd backend && npm run build

# 后端类型检查（0 错误为通过）
cd backend && npm run typecheck

# Electron 客户端引擎（build/dist/agent-engine.mjs）
cd backend && npm run build:electron

# 前端正式产物（frontend/dist/）
cd frontend && npm run build
```

### 构建桌面应用（AppImage）

```bash
# 一步打包（前端 + 客户端引擎 + Electron 主进程 + AppImage）
bash build/build.sh
# 产物：build/dist-electron/MyAgent-1.0.0.AppImage
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat` | 发送消息（SSE 流式响应） |
| POST | `/api/chat/steer` | 处理中注入队列消息 |
| POST | `/api/execute` | Agent 模式执行指令（SSE） |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 创建会话 |
| GET | `/api/sessions/:id` | 会话历史消息 |
| PUT | `/api/sessions/:id` | 更新会话（重命名） |
| DELETE | `/api/sessions/:id` | 删除会话 |
| DELETE | `/api/sessions/:id/messages` | 删除一轮对话（按 user 消息序号，body `{ "index": n }`） |
| GET | `/api/sessions/:id/export` | 导出会话为 JSONL（白名单清洗，下载文件） |
| POST | `/api/sessions/import` | 导入 JSONL 会话（宽容解析坏行，创建新会话） |
| POST | `/api/sessions/:id/abort` | 中断处理 |
| POST | `/api/sessions/:id/sync` | 桌面客户端会话同步（Electron 主进程） |
| GET | `/api/sessions/:id/tokens` | Token 用量统计 |
| POST | `/api/sessions/:id/compact` | 手动触发上下文压缩 |
| GET | `/api/config` | 读取运行时配置（含 model_presets / tool_permissions） |
| POST | `/api/config` | 保存运行时配置（含限流、工具权限，落盘） |
| POST | `/api/test-connection` | 测试模型服务连通性 |
| POST | `/api/confirm-decision` | 工具调用确认决策（allow / always_allow / block） |
| GET | `/api/memory` | 读取跨会话记忆全文（`{ content }`） |
| POST | `/api/memory` | 保存跨会话记忆（`{ content }`，空串即清空） |
| GET | `/api/list-directory` | 目录浏览（设置页工作目录选择用） |
| GET | `/api/extensions` | 扩展列表（含发现但未启用的；来源 npm / dir） |
| GET | `/api/extensions/commands` | 已启用扩展的命令列表（前端 / 命令合并） |
| POST | `/api/extensions/:name/toggle` | 扩展启停（落盘 data/extensions-state.json，新会话生效） |
| POST | `/api/extensions/:name/command` | 执行扩展命令（body `{ "args": "..." }`，返回 handler 文本结果） |
| GET | `/health` | 健康检查 |

### POST /api/chat 请求体

```json
{
  "message": "用户消息",
  "sessionId": "可选，不传则自动创建新会话",
  "mode": "chat | agent",
  "systemPrompt": "可选，自定义系统提示词",
  "name": "可选，新会话名称",
  "images": "可选，图片数组（base64）",
  "modelOverrides": "可选，覆盖模型配置"
}
```

响应为 SSE 事件流，事件类型包括：`session_created`、`agent_start`、`message_delta`、`tool_start`、`tool_end`、`confirmation_required`、`auto_compact`、`agent_end`、`error`、`aborted`。

## 两种工作模式

### 对话模式（chat）
自然语言对话，Agent 以文本回复为主。工具调用可折叠显示。

### Agent 模式（agent）
类似 OpenCode 风格，Agent 自动生成代码、执行、验证并输出结果。工具调用默认展开，显示完整执行过程。

## 工具系统（11 个工具）

| 工具 | 功能 | 安全策略 |
|------|------|---------|
| `read_file` | 读取文件内容 | 路径穿越防护 |
| `write_file` | 写入/修改文件 | 路径穿越防护 |
| `edit_file` | 精准文本替换（一次多段 edits，任一匹配失败整体回滚） | 路径穿越防护 + 唯一性/区间重叠校验 + BOM 处理 |
| `grep_search` | 递归内容搜索（ripgrep 优先，内置递归 fallback） | 自动跳过 node_modules/.git/dist；目录越界拒绝；结果上限 200 |
| `list_files` | 目录树浏览（depth 0-3） | 目录越界拒绝；条目上限 2000 |
| `execute_command` | 执行 Shell 命令 | 黑名单命令 + 危险模式确认 + 只读命令放行 + 长度/超时限制 |
| `search_web` | 网络搜索 | 内置实现 |
| `run_python` | 执行 Python 代码 | 临时文件 + 超时控制 |
| `run_skill` | 加载技能说明（.pi/skills） | 技能目录扫描，限制为说明文本加载 |
| `remember` | 写入跨会话记忆（data/memory.md） | 2000 字符上限 + 换行单行化 + 行首 `#` 转义（防 markdown 注入）+ 完全重复去重 |
| `subagent` | 启动子代理独立执行子任务 | 独立会话隔离 + 权限沿用主会话判定 + 结果上限 |

工具权限由 `data/tool-permissions.json` 统一管控（见下节）。

## 工具权限系统（allow / ask / deny）

所有工具执行前经过 `beforeToolCall` 门控判定（`decideToolGate`）：

- **allow** — 直接执行（默认策略，除危险工具外全部 allow）
- **ask** — 进入待确认队列，前端弹窗由用户批准/拒绝
- **deny** — 工具被禁用，直接返回拒绝结果不执行

默认配置：`execute_command` 与 `run_python` 为 `ask`，其余 `allow`；未配置的工具默认 `allow`。
持久化于 `data/tool-permissions.json`（启动自动创建），可通过 `POST /api/config` 的 `tool_permissions` 字段或前端「设置 → 工具权限」修改，即时生效。

`execute_command` 的 ask 语义保留原有策略：仅危险命令（`rm`、`chmod 777`、`git push --force`、写入系统目录等）弹窗确认，只读命令（cat/ls/find/grep 等）直接放行。

## 新增能力

### 自动上下文压缩
每轮结束（`turn_end`）检查 token 用量（`token-tracker`），超过阈值自动将早期消息压缩为摘要并替换上下文，前端收到 `auto_compact` 事件提示；也可通过 `POST /api/sessions/:id/compact` 手动触发。

**架构说明**：数据流为 `services/agent-service.ts`（监听 turn_end）→ `services/token-tracker.ts`（`getTokenUsage` 阈值判定、`compactMessages` 执行压缩，含 LLM 摘要与 force 模式）→ `AgentSessionService.replaceMessages` 替换上下文 → WS/SSE 下发 `auto_compact` 事件，前端 `store/chat-store.ts` 消费。阈值/冷却/防抖/摘要模型等参数集中在 `token-tracker.ts` 顶部常量区。

### 消息编辑与删除
- 编辑：前端将「原消息 + 其回复」整体删除后作为新消息重发（含后端落库）
- 删除：`DELETE /api/sessions/:id/messages` 按 user 消息序号删除一整轮对话

**架构说明**：删除逻辑在 `routes/session.routes.ts`（按 user 消息 index 定位并删除其后的连续回复）；前端编辑/删除入口在 `store/chat-store.ts`（编辑内部实现为「删除后重发」）。

### 技能系统（run_skill）
`.pi/skills/` 下的技能定义（YAML/文本）在会话创建时扫描加载并注入系统提示词；模型通过 `run_skill` 工具按需读取技能说明执行。

**架构说明**：`services/skills-loader.ts` 负责扫描/解析技能文件（parseSkillFile / scanSkillsDir / findSkillByName，均可复用）；`services/session-manager.ts` 创建会话时把技能清单注入 system prompt；`tools/run-skill.tool.ts` 提供按名读取技能说明的工具。

### 跨会话记忆
`remember` 工具将用户明确要求记住的偏好写入 `data/memory.md`（`- [日期] 内容` 条目，上限 500 条自动截断最旧）；每次新建会话自动注入 system prompt，模型被要求遵循。管理面板「设置 → 记忆管理」可查看/修改/清空（`GET/POST /api/memory`）。Electron 客户端引擎不自动注入，由主进程自行拼入 system prompt。

**架构说明**：数据流为 `tools/remember.tool.ts`（写入，2000 字符上限/换行单行化/行首 `#` 转义/完全重复去重）→ `services/memory-service.ts`（appendMemory 追加、buildMemoryPromptSection 组装注入段）→ `services/session-manager.ts` createSession 将记忆段拼入 effectivePrompt（agent/chat 两分支统一）；管理 API 在 `routes/memory.routes.ts`，前端在 SettingsModal「记忆管理」tab。

### 多模型预设
`config.ts` 内置 chat / agent 两套默认预设（`modelPresets`），前端「设置 → 模型预设」可增删改选（localStorage），选中预设经 `modelOverrides` 通道覆盖会话模型配置；`GET /api/config` 返回 `model_presets` 列表。

**架构说明**：预设定义在 `src/config.ts`（modelPresets / getModelPresets / resolveModelPresetByName，DeepSeek 预设的 apiKey 从 `DEEPSEEK_API_KEY` 读取）；前端 `services/api-config.ts` 维护选中态（getLlmOverrides 优先返回选中预设，兼容手动 key）；会话创建时经 `session-manager.createSession` 的 modelOverrides 参数 → `agent/llm-config.ts` createQwenModel 生效。后端不持久化预设（前端存 localStorage）。

### 子代理
`subagent` 工具启动一个独立会话的子代理执行子任务，支持自定义指令/提示词，结果带回主会话；工具权限沿用主会话配置。

**架构说明**：`tools/subagent.tool.ts` 通过 `agent/agent-factory.ts` 的 createAgent 创建隔离的 Agent 实例（独立会话与主会话解耦），子代理完成后返回结构化结果；权限判定复用 `agent-factory` 的 `decideToolGate`。

### 会话导入导出（JSONL）
- 导出：白名单字段清洗，丢弃前端私有字段（`id` / `isStreaming` / `duration` 等），保留 role/content/timestamp 与 assistant 用量、toolResult 元数据
- 导入：宽容解析（跳过空行与非法行），只恢复可恢复字段，自动创建新会话

**架构说明**：序列化/解析纯函数在 `services/session-jsonl.ts`（serializeSessionToJsonl / parseSessionJsonl，无副作用便于单元测试）；路由在 `routes/session.routes.ts`（GET `/:id/export`、POST `/sessions/import`）；前端入口在侧边栏（导出/导入按钮）。

## 配置

### backend/src/config.ts

```typescript
export const config = {
  port: 7980,                                    // 服务端口（PORT）
  dataDir: '../data',                            // 运行时数据目录（DATA_DIR）
  qwenBaseUrl: '<你的 LLM 服务地址，如 http://localhost:1234/v1>',   // Qwen API 地址（QWEN_BASE_URL）
  qwenModel: 'qwen3.6-35b-a3b-apex-quality',    // 模型名（QWEN_MODEL）
  defaultSystemPrompt: '你是一个智能助手...',      // 默认系统提示词（SYSTEM_PROMPT）
  workDir: process.cwd(),                        // 工作目录（WORK_DIR）
  // chat / agent 各自独立的 baseUrl/model/apiKey
  // thinkingLevel / enableThinking / thinkingBudget / preserveThinking（思考模式）
  // llmTimeoutMs / defaultMaxTokens（LLM 超时与输出上限）
  // webAgentEnabled（网页版 Agent 开关；false 时服务端不做 Agent，由桌面客户端执行）
  // Agent 迭代限制：agentMaxTurns / agentMaxToolCallsPerTurn / agentMaxConsecutiveErrors
};
```

### 环境变量

启动时自动加载项目根 `.env`（可用 `.env.example` 为模板复制），全部配置项支持环境变量覆盖。完整清单：

| 环境变量 | 默认值 | 用途 |
|---------|--------|------|
| `PORT` | `7980` | 服务端口 |
| `DATA_DIR` | `../data` | 运行时数据目录（DB、JSON 配置、memory.md） |
| `FRONTEND_DIR` | `../frontend/dist` | 前端静态文件目录（后端伺服） |
| `ADMIN_ACCOUNT` | `admin` | 管理员账号 |
| `ADMIN_PASSWORD` | `123456`（仅首次启动默认值） | 管理员密码，**公开部署必须修改**（推荐用 `.env` 设置强密码） |
| `QWEN_BASE_URL` | 空（需配置） | 默认 LLM API 地址（chat/agent 未单独配置时回退） |
| `QWEN_MODEL` | `qwen3.6-35b-a3b-apex-quality` | 默认模型名 |
| `QWEN_API_KEY` | 空 | 默认 API Key |
| `CHAT_BASE_URL` / `CHAT_MODEL` / `CHAT_API_KEY` | 空（回退 Qwen） | Chat 模式独立 LLM 配置 |
| `AGENT_BASE_URL` / `AGENT_MODEL` / `AGENT_API_KEY` | 空（回退 Qwen） | Agent 模式独立 LLM 配置 |
| `SYSTEM_PROMPT` | 内置默认助手提示词 | 默认系统提示词 |
| `WORK_DIR` | 进程 cwd | 工作目录（Agent 工具可访问范围） |
| `LLM_TIMEOUT_MS` | `120000` | LLM 请求超时 |
| `THINKING_LEVEL` | `medium` | 推理深度（multi-level 模型） |
| `ENABLE_THINKING` | `true` | 思考模式开关（switch 型模型） |
| `THINKING_BUDGET` | `1024` | 思考 token 预算 |
| `PRESERVE_THINKING` | `false` | 保留思考内容 |
| `WEB_AGENT_ENABLED` | `true` | 网页版 Agent 执行开关（false 为瘦服务端模式） |
| `WS_HEARTBEAT_MS` | `30000` | WebSocket 心跳间隔 |
| `AGENT_MAX_TURNS` | `20` | 最大对话轮数（初始默认，运行时以 rate-limit-config.json 为准） |
| `AGENT_MAX_TOOL_CALLS_PER_TURN` | `10` | 每轮最大工具调用数（同上） |
| `AGENT_MAX_CONSECUTIVE_ERRORS` | `5` | 连续错误阈值（同上） |
| `DEEPSEEK_API_KEY` | 空 | DeepSeek 模型预设 Key + 上下文压缩摘要模型回退 |
| `TAVILY_API_KEY` | 空 | MCP 网络搜索工具 Key（mcp/src/tools/webSearch.js） |
| `PI_CLI_PATH` / `RPC_*` | 见 .env.example | 已废弃（RPC 进程功能已下线，仅保留兼容读取） |
| `TOOL_RATE_LIMIT_PER_MIN` / `TOOL_RATE_LIMIT_MAX_ERRORS` | `20` / `5` | 已废弃（工具限流从未接线，仅保留兼容读取） |

运行时配置经 `GET/POST /api/config` 读写（优先级：`/api/config` 运行时设置 > 环境变量 > 内置默认）。

### data/ 运行时文件

| 文件 | 用途 | 管理方式 |
|------|------|---------|
| `myagent.db` | 会话/用户持久化（sql.js） | 自动 |
| `rate-limit-config.json` | 限流与 Agent 迭代限制 | POST /api/config、前端设置 |
| `tool-permissions.json` | 工具权限（allow/ask/deny） | POST /api/config、前端「工具权限」tab |
| `memory.md` | 跨会话记忆 | remember 工具、GET/POST /api/memory、前端「记忆管理」tab |

## 使用示例

```bash
# 创建会话并发送消息
curl -X POST http://localhost:7980/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "帮我写一个 Hello World 的 Python 脚本", "mode": "agent"}'
```

```bash
# 中断会话处理
curl -X POST http://localhost:7980/api/sessions/<SESSION_ID>/abort
```

```bash
# 导出会话为 JSONL（<账号>/<密码> 替换为你的登录凭据）
curl -u <账号>:<密码> http://localhost:7980/api/sessions/<SESSION_ID>/export -o session.jsonl

# 导入 JSONL 会话
curl -X POST http://localhost:7980/api/sessions/import \
  -H "Content-Type: application/jsonl" -u <账号>:<密码> \
  --data-binary @session.jsonl
```

## 安全说明

- `execute_command` 工具禁止以下命令：`sudo`、`rm -rf /`、`mkfs`、`dd`、`chmod 777`；危险模式（rm、git push --force、写系统目录等）需用户确认
- 命令最长 10000 字符，超时 60 秒
- 文件操作工具（read/write/edit/grep/list）有路径穿越防护，禁止访问工作目录之外
- `remember` 工具防注入：换行单行化、行首 `#` 转义、2000 字符上限
- 工具权限 deny 可随时禁用任意工具；`execute_command` / `run_python` 默认需确认
- 会话 30 分钟不活跃自动清理

## 测试

后端单元测试位于 `backend/tests/unit/`，使用 Node 内置 `node:test` + tsx（零新增依赖）：

| 文件 | 覆盖范围 |
|------|---------|
| `memory.test.ts` | memory-service 全接口（追加/去重/500 条截断/覆盖/模板剥离/prompt 注入） |
| `tools.test.ts` | edit_file、grep_search、list_files、remember 冒烟 + session-jsonl 清洗/宽容解析 |
| `permissions.test.ts` | tool-permission-config 落盘与 decideToolGate 判定（allow/ask/deny） |

## 开发指南

> 面向二次开发的标准操作步骤与架构约束。原则：小步改动、保持现有行为、新增代码必须过 `npm run typecheck`（0 错误）与 `npm test`。

### 新增工具

1. 在 `backend/src/tools/` 新建 `<name>.tool.ts`，导出 `createXxxTool(...)`，返回 `AgentTool`（含 TypeBox `parameters` schema，参见 `read-file.tool.ts` 写法）
2. 在 `backend/src/tools/index.ts` 的 `createCustomTools` 返回数组中注册（`tools/index.ts` 头部有核对清单）
3. 评估默认权限：在 `backend/src/config/tool-permission-config.ts` 的默认配置中加入该工具（allow/ask/deny），并同步前端 `SettingsModal` 的 `DEFAULT_PERMISSIONS` 初始值
4. 前端 `TOOL_LABELS` 添加中文名（工具展示处）
5. 在 `backend/tests/unit/` 补充单元测试（node:test + tsx，零新增依赖）
6. 更新本文档「工具系统」表
7. 验证：`npm run build` + `npm run typecheck` + `npm test`

### 新增 API

1. 在 `backend/src/routes/` 新建 `<name>.routes.ts`，导出 `xxxRouter`（参见 `session.routes.ts` 写法；Express 5 的 `req.params` 需用 `String(req.params.id)` 收窄）
2. 在 `backend/src/routes/index.ts` 挂载（`apiRouter.use(xxxRouter)`，`routes/index.ts` 头部有核对清单）
3. 认证：业务路由挂到 `apiRouter` 即自动受 auth 中间件保护（`app.ts` 中 `createAuthMiddleware` 挂载在 `apiRouter` 之前）；仅登录/注册等公开接口放 `auth/index.ts` 的 `createAuthRouter`，路径与 `routes/index.ts` 冲突时注意挂载顺序
4. 前端在 `frontend/src/services/api.ts`（或 `api-config.ts`）添加封装
5. 更新本文档「API 接口」表
6. 涉及 WebSocket 推送时，经 `session.events` 的 `sse` / `done` 事件通道下发（见 `index.ts` 的 `onSse` 转发）

### 新增配置项

1. 后端字段：`backend/src/config/advanced-config.ts`（或对应 config 文件）添加字段 + TypeBox schema 校验（非法值返回 400 不落盘）
2. 暴露：`backend/src/routes/config.routes.ts` 的 GET `/api/config` 返回该字段、POST `/api/config` 接收并落盘（需持久化的字段仿照 `rate-limit-config.ts` / `tool-permission-config.ts` 的 load/get/update 三函数模式）
3. 前端：`SettingsModal` 对应 tab 添加控件（中文标签 + 说明文字，参照现有 tab 结构）
4. 更新本文档「环境变量」表（若提供 env 默认值）与「配置」章节
5. 验证：`npm run typecheck` + 手动 `GET/POST /api/config` 冒烟

### 架构约束（新增代码必须遵守）

- **工具按会话实例化**：`session-manager.createSession` 每次调用 `createAgentTools` / `createChatTools` 重新构造工具数组（`createXxxTool(workDir)` 闭包捕获会话工作目录）；工具内**不得**在模块级缓存会话相关状态
- **SessionManager 全局单例**：通过 `initSessionManager()` 初始化、`getSessionManager()` 获取；不要在路由中 `new SessionStore()` 或另建会话容器
- **上下文压缩在 `turn_end` 触发**：压缩逻辑只在 `agent-service.ts` 的 turn_end 监听中执行，不要在其他事件时机自行触发
- **Electron 引擎独立打包**：`backend/src/agent-engine/` 是客户端引擎入口（`npm run build:electron` 独立 esbuild 产物），不经过 `session-manager`（记忆注入、权限持久化等仅服务端路径生效）；给客户端引擎加能力时需单独验证
- **DB 单点**：所有持久化经 `db/`（UserRepository / SessionStore），不要绕过
- **类型纪律**：后端 `erasableSyntaxOnly` 开启（构造函数参数属性需显式字段赋值）；pi-ai 的 `Model` 类型无 `apiKey` 字段但运行时对象上有（`llm-config.ts` 有注释），新增读取处用 `(model as { apiKey?: string })` 收窄
- **死代码纪律**：新增能力不落地即不接线；废弃文件直接删除并同步清理 `build.sh` / `build/package.json` 等构建脚本中的引用（本项目曾因连接页废弃后构建脚本残留引用而需要二次治理）

## 架构说明

- **后端**：Express + TypeScript（ESM），Agent 核心基于 pi-mono（`@earendil-works/pi-agent-core` + `pi-ai`）；会话编排（`services/agent-service.ts`）、会话管理（`services/session-manager.ts`）、DB 单点（`db/`：UserRepository / SessionStore，sql.js）
- **前端**：React 19 + Vite + Zustand；SSE 流式消费（`services/`）、Zustand 状态（`store/`）
- **Electron 客户端**：`build/` 目录，主进程复用 `backend/src/agent-engine/`（esbuild 单文件 `agent-engine.mjs`）
- **MCP**：`mcp/` 内置 stdio MCP server，经 `services/mcp-bridge.ts` 桥接注入 Agent 工具
- **持久化**：`data/` 运行时目录（自动创建，已 gitignore）：`myagent.db`（会话/用户）、`tool-permissions.json`（工具权限）、`rate-limit-config.json`（限流）、`memory.md`（跨会话记忆）
