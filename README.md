# MyAgent - 个人智能 Agent 系统

基于 [pi-mono](https://github.com/earendil-works/pi-mono) 框架的个人智能 Agent 系统：自然语言对话 + 自主代码生成/执行（类似 OpenCode 能力）。前后端分离，支持本地模型（OpenAI 兼容 API）与云端 DeepSeek，提供网页版（Express + SSE）与桌面客户端（Electron + AgentEngine）两种形态。

> **开源许可**：本项目基于 [MIT 许可](LICENSE) 开源，构建于 [pi-mono](https://github.com/earendil-works/pi-mono)（`@earendil-works/pi-agent-core` / `pi-ai`，MIT）之上。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-339933.svg)](https://nodejs.org)
[![Express 5](https://img.shields.io/badge/Backend-Express%205-000000.svg)](backend/)
[![React 19](https://img.shields.io/badge/Frontend-React%2019-61DAFB.svg)](frontend/)
[![Electron](https://img.shields.io/badge/Desktop-Electron-47848F.svg)](build/)

## 界面截图

<!-- TODO: 补充界面截图（docs/screenshot.png），待添加 -->

## 功能特性

- **双工作模式**：对话模式自然问答，Agent 模式自动生成代码、执行、验证并输出结果
- **自动上下文压缩**：token 超阈值自动摘要压缩早期消息，前端收到 `auto_compact` 事件提示，也可手动触发
- **跨会话记忆**：`remember` 工具持久化用户偏好到 `data/memory.md`，新会话自动注入 system prompt
- **子代理**：启动隔离会话的子代理执行子任务，结果带回主会话，权限沿用主会话判定
- **多模型预设**：chat / agent 各自独立模型配置，内置 DeepSeek 预设，前端一键切换
- **工具权限门控**：allow / ask / deny 三级权限，危险命令弹窗确认，路径穿越防护
- **11 个内置工具**：文件读写/编辑、grep、目录浏览、Shell 执行、Python 执行、网络搜索、技能、记忆、子代理
- **技能系统（skills）**：`.pi/skills/` 技能定义随会话注入，模型按需加载
- **MCP 与扩展体系**：内置 MCP 桥接（如 Tavily 搜索），扩展工具动态加载启停
- **会话 JSONL 导入导出**：白名单字段清洗、宽容解析，会话可迁移备份
- **5 套主题**：深浅色等 5 套主题自由切换
- **Electron 桌面客户端**：AppImage 一键打包，内置 AgentEngine，独立可用

## 技术栈

- **后端**：Node.js 22+、Express 5、TypeScript（ESM）、pi-mono（`@earendil-works/pi-agent-core` + `pi-ai`）、esbuild、node:test
- **前端**：React 19、Vite 6、Zustand 5、TypeScript
- **大模型**：本地 Qwen（LM Studio，OpenAI 兼容 API）或云端 DeepSeek
- **通信**：RESTful API + Server-Sent Events（SSE）；Electron 客户端经 WebSocket/RPC 与主进程通信

## 项目结构

```
my-Agent/
├── backend/        # Express + TypeScript 后端（agent 核心 / agent-engine / services / tools / routes）
├── frontend/       # React + Vite + TypeScript 前端（components / services / store / types）
├── build/          # Electron 打包（dist/agent-engine.mjs、主进程、build.sh）
├── data/           # 运行时数据（myagent.db、tool-permissions.json、memory.md 等，自动创建）
├── extensions/     # Agent 扩展（扩展工具加载）
├── mcp/            # MCP 服务端（my-mcp-server）
└── .pi/skills/     # Agent 技能定义
```

## 快速开始

### 前置条件

- Node.js 22+
- 一个 OpenAI 兼容的 LLM 服务：本地模型（如 LM Studio 部署 Qwen，`http://localhost:1234/v1`）或云端 DeepSeek；可在 `.env` 或前端设置页配置

### 启动

```bash
# 后端（默认 http://localhost:7980，可用 PORT 覆盖）
cd backend && npm install && npm run dev

# 前端（http://localhost:5173，/api 已代理到后端）
cd frontend && npm install && npx vite
```

### 测试与构建

```bash
cd backend && npm test          # node:test 单元测试（零新增依赖）
cd backend && npm run build     # 后端产物 backend/dist/index.js
cd backend && npm run typecheck # 类型检查（0 错误为通过）
cd frontend && npm run build    # 前端产物 frontend/dist/
```

## 配置

启动时自动加载项目根 `.env`（以 `.env.example` 为模板复制），全部配置项支持环境变量覆盖；运行时配置经 `GET/POST /api/config` 读写（优先级：运行时设置 > 环境变量 > 内置默认）。

| 环境变量 | 默认值 | 用途 |
|---------|--------|------|
| `PORT` | `7980` | 服务端口 |
| `DATA_DIR` | `../data` | 运行时数据目录（DB、JSON 配置、memory.md） |
| `FRONTEND_DIR` | `../frontend/dist` | 前端静态文件目录（后端伺服） |
| `ADMIN_ACCOUNT` / `ADMIN_PASSWORD` | `admin` / `123456` | 管理员凭据，**公开部署必须修改** |
| `QWEN_BASE_URL` / `QWEN_MODEL` / `QWEN_API_KEY` | 空 | 默认 LLM 配置（chat/agent 未单独配置时回退） |
| `CHAT_BASE_URL` / `CHAT_MODEL` / `CHAT_API_KEY` | 空（回退默认） | Chat 模式独立 LLM 配置 |
| `AGENT_BASE_URL` / `AGENT_MODEL` / `AGENT_API_KEY` | 空（回退默认） | Agent 模式独立 LLM 配置 |
| `SYSTEM_PROMPT` | 内置默认助手 | 默认系统提示词 |
| `WORK_DIR` | 进程 cwd | 工作目录（Agent 工具可访问范围） |
| `LLM_TIMEOUT_MS` | `120000` | LLM 请求超时 |
| `THINKING_LEVEL` / `ENABLE_THINKING` / `THINKING_BUDGET` / `PRESERVE_THINKING` | `medium` / `true` / `1024` / `false` | 思考模式参数 |
| `WEB_AGENT_ENABLED` | `true` | 网页版 Agent 执行开关（false 为瘦服务端模式，由桌面客户端执行） |
| `AGENT_MAX_TURNS` / `AGENT_MAX_TOOL_CALLS_PER_TURN` / `AGENT_MAX_CONSECUTIVE_ERRORS` | `20` / `10` / `5` | Agent 迭代限制（运行时以 rate-limit-config.json 为准） |
| `DEEPSEEK_API_KEY` | 空 | DeepSeek 模型预设 Key + 上下文压缩摘要模型回退 |
| `TAVILY_API_KEY` | 空 | MCP 网络搜索工具 Key |

> 已废弃（仅兼容读取）：`PI_CLI_PATH` / `RPC_*`（RPC 进程已下线）、`TOOL_RATE_LIMIT_PER_MIN` / `TOOL_RATE_LIMIT_MAX_ERRORS`（工具限流从未接线）。

### data/ 运行时文件（按需自动创建）

| 文件 | 用途 | 管理方式 |
|------|------|---------|
| `myagent.db` | 会话/用户持久化（sql.js） | 自动 |
| `rate-limit-config.json` | 限流与 Agent 迭代限制 | POST /api/config、前端设置 |
| `tool-permissions.json` | 工具权限（allow/ask/deny） | POST /api/config、前端「工具权限」tab |
| `memory.md` | 跨会话记忆 | remember 工具、GET/POST /api/memory、前端「记忆管理」tab |

## 使用

### 两种工作模式

- **对话模式（chat）**：自然语言对话，Agent 以文本回复为主，工具调用可折叠显示
- **Agent 模式（agent）**：类似 OpenCode 风格，Agent 自动生成代码、执行、验证并输出结果，工具调用默认展开

### 工具系统（11 个工具）

| 工具 | 功能 | 安全策略 |
|------|------|---------|
| `read_file` / `write_file` / `edit_file` | 读 / 写 / 精准文本替换 | 路径穿越防护；edit 唯一性/区间校验 + 失败整体回滚 |
| `grep_search` / `list_files` | 递归搜索 / 目录树浏览 | 跳过 node_modules/.git/dist；越界拒绝；结果上限 |
| `execute_command` | 执行 Shell 命令 | 黑名单 + 危险命令确认 + 只读命令放行 + 长度/超时限制 |
| `search_web` | 网络搜索 | 内置实现 |
| `run_python` | 执行 Python 代码 | 临时文件 + 超时控制 |
| `run_skill` | 加载技能说明（.pi/skills） | 仅限说明文本加载 |
| `remember` | 写入跨会话记忆（data/memory.md） | 2000 字符上限 + 防注入 + 去重 |
| `subagent` | 启动子代理独立执行子任务 | 会话隔离 + 权限沿用主会话 + 结果上限 |

所有工具执行前经 `beforeToolCall` 门控（`decideToolGate`）：**allow** 直接执行（默认）、**ask** 弹窗确认（`execute_command` / `run_python` 默认）、**deny** 禁用。权限持久化于 `data/tool-permissions.json`，可在「设置 → 工具权限」修改，即时生效。

### 使用示例

```bash
# 创建会话并发送消息（Agent 模式，SSE 流式）
curl -X POST http://localhost:7980/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "帮我写一个 Hello World 的 Python 脚本", "mode": "agent"}'

# 导出会话为 JSONL / 中断处理
curl -u <账号>:<密码> http://localhost:7980/api/sessions/<ID>/export -o session.jsonl
curl -X POST http://localhost:7980/api/sessions/<ID>/abort
```

### API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat` | 发送消息（SSE 流式响应） |
| POST | `/api/chat/steer` | 处理中注入队列消息 |
| POST | `/api/execute` | Agent 模式执行指令（SSE） |
| GET/POST | `/api/sessions` | 会话列表 / 创建会话 |
| GET/PUT/DELETE | `/api/sessions/:id` | 会话历史 / 重命名 / 删除 |
| DELETE | `/api/sessions/:id/messages` | 删除一轮对话（body `{ "index": n }`） |
| GET | `/api/sessions/:id/export` | 导出会话为 JSONL（白名单清洗） |
| POST | `/api/sessions/import` | 导入 JSONL 会话（宽容解析，创建新会话） |
| POST | `/api/sessions/:id/abort` | 中断处理 |
| POST | `/api/sessions/:id/sync` | 桌面客户端会话同步 |
| GET | `/api/sessions/:id/tokens` | Token 用量统计 |
| POST | `/api/sessions/:id/compact` | 手动触发上下文压缩 |
| GET/POST | `/api/config` | 读写运行时配置（限流、工具权限，落盘） |
| POST | `/api/test-connection` | 测试模型服务连通性 |
| POST | `/api/confirm-decision` | 工具调用确认决策（allow / always_allow / block） |
| GET/POST | `/api/memory` | 读取 / 保存跨会话记忆 |
| GET | `/api/list-directory` | 目录浏览（设置页工作目录选择用） |
| GET | `/api/extensions` | 扩展列表（含发现未启用的） |
| POST | `/api/extensions/:name/toggle` | 扩展启停（落盘，新会话生效） |
| POST | `/api/extensions/:name/command` | 执行扩展命令（body `{ "args": "..." }`） |
| GET | `/health` | 健康检查 |

`POST /api/chat` 请求体：`message`（必填）、`sessionId`（可选，不传自动创建新会话）、`mode`（chat\|agent）、`systemPrompt`、`name`、`images`、`modelOverrides`。响应为 SSE 事件流：`session_created` / `agent_start` / `message_delta` / `tool_start` / `tool_end` / `confirmation_required` / `auto_compact` / `agent_end` / `error` / `aborted`。

## 桌面客户端（AppImage）

Electron 桌面客户端内置 AgentEngine（esbuild 单文件），可独立使用 Agent 能力，与会话服务经 WebSocket/RPC 同步。

```bash
bash build/build.sh
# 产物：build/dist-electron/MyAgent-1.0.0.AppImage
```

## 安全说明

- `execute_command` 禁止 `sudo`、`rm -rf /`、`mkfs`、`dd`、`chmod 777`；危险模式（rm、git push --force、写系统目录等）需用户确认；命令最长 10000 字符，超时 60 秒
- 文件操作工具（read/write/edit/grep/list）有路径穿越防护，禁止访问工作目录之外
- `remember` 工具防注入：换行单行化、行首 `#` 转义、2000 字符上限
- 工具权限 deny 可随时禁用任意工具；`execute_command` / `run_python` 默认需确认
- 会话 30 分钟不活跃自动清理；公开部署务必修改默认管理员密码

## 测试

后端单元测试位于 `backend/tests/unit/`，使用 Node 内置 `node:test` + tsx（零新增依赖）：

```bash
cd backend && npm test
```

覆盖范围：memory-service 全接口（追加/去重/截断/注入）、工具冒烟与 session-jsonl 清洗/宽容解析、tool-permission-config 落盘与 decideToolGate 判定（allow/ask/deny）。

## 开发指南

面向维护者：新增工具 / 新增 API / 新增配置项的标准步骤与架构约束见 [docs/开发指南.md](docs/开发指南.md)。

## 许可

本项目基于 [MIT 许可](LICENSE) 开源，构建于 [pi-mono](https://github.com/earendil-works/pi-mono)（`@earendil-works/pi-agent-core` / `pi-ai`，MIT）。
