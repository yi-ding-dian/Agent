# My MCP Server

基于官方 `@modelcontextprotocol/sdk` 构建的模块化 [Model Context Protocol (MCP)](https://modelcontextprotocol.io) 服务。

## 项目结构

```
├── src/
│   ├── index.js              # 入口文件 — 组装所有模块并启动
│   ├── server.js             # McpServer 实例
│   ├── tools/                # 工具模块 🛠
│   │   ├── index.js          #   聚合注册
│   │   ├── calculator.js     #   四则运算
│   │   ├── time.js           #   日期时间查询
│   │   └── echo.js           #   消息回显
│   ├── resources/            # 资源模块 📄
│   │   ├── index.js          #   聚合注册
│   │   └── system.js         #   操作系统/硬件信息
│   └── prompts/              # 提示模板模块 💡
│       ├── index.js          #   聚合注册
│       └── greeting.js       #   多语言问候
├── client/
│   └── test-client.js        # 自动化测试客户端
├── start.sh                  # 启动服务
├── stop.sh                   # 停止服务
└── package.json
```

## 环境要求

- **Node.js >= 18**

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动服务
./start.sh

# 或者直接用 node 启动：
node src/index.js
```

服务使用 **stdio**（标准输入/输出）作为传输层，这是 MCP 的标准本地进程通信方式。

## 运行测试

```bash
node client/test-client.js
```

测试客户端会：
1. 自动启动服务进程
2. 列出所有 tools、resources 和 prompts
3. 调用每个 tool 并验证返回值
4. 读取 system resource
5. 生成 greeting prompt

## 功能

### 工具（Tools）

| 工具名       | 功能说明                    | 参数                                         |
| ------------ | --------------------------- | -------------------------------------------- |
| `calculator` | 加减乘除四则运算            | `a`, `b`, `operation`                        |
| `get_time`   | 获取当前时间或转换时间戳    | `timestamp?`, `format?` (iso/locale/unix)    |
| `echo`       | 回传消息                    | `message`, `upper?`                          |

### 资源（Resources）

| URI             | 说明                        |
| --------------- | --------------------------- |
| `system://info` | 主机名、操作系统、CPU、内存等 |

### 提示模板（Prompts）

| 名称       | 功能说明          | 参数                                  |
| ---------- | ----------------- | ------------------------------------- |
| `greeting` | 多语言问候        | `name`, `language?`, `formal?`        |

## 新增工具

1. 在 `src/tools/` 下创建新文件（如 `src/tools/hello.js`）：

```js
import { z } from "zod";

export function registerHello(server) {
  server.tool("hello", "发送问候", {
    name: z.string().describe("你的名字"),
  }, async ({ name }) => {
    return { content: [{ type: "text", text: `你好, ${name}!` }] };
  });
}
```

2. 在 `src/tools/index.js` 中注册：

```js
import { registerHello } from "./hello.js";

export function registerAllTools(server) {
  // ... 已有注册 ...
  registerHello(server);
}
```

**resources** 和 **prompts** 的扩展方式相同。

## 与 MCP 客户端集成

### Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "my-mcp-server": {
      "command": "node",
      "args": ["/绝对/路径/mcp/src/index.js"]
    }
  }
}
```

## 脚本

| 命令              | 说明              |
| ----------------- | ----------------- |
| `npm start`       | 启动服务          |
| `npm test`        | 运行测试客户端    |
| `./start.sh`      | 通过脚本启动      |
| `./stop.sh`       | 通过脚本停止      |
