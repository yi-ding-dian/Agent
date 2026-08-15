import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_COMMAND = "node";
const SERVER_ARGS = ["src/index.js"];

async function main() {
  console.log("启动 MCP 测试客户端...\n");

  const transport = new StdioClientTransport({
    command: SERVER_COMMAND,
    args: SERVER_ARGS,
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    console.log("✓ 已连接到 MCP 服务\n");

    // ---- 列出所有工具 ----
    console.log("━━━ 工具列表 ━━━");
    const { tools } = await client.listTools();
    console.log(`服务提供了 ${tools.length} 个工具：`);
    for (const t of tools) {
      console.log(`  • ${t.name}: ${t.description ?? "（无描述）"}`);
    }
    console.log();

    // ---- 测试计算器：加法 ----
    console.log("━━━ 测试计算器：3 + 5 ━━━");
    const calcResult = await client.callTool({
      name: "calculator",
      arguments: { a: 3, b: 5, operation: "add" },
    });
    for (const item of calcResult.content) {
      if (item.type === "text") console.log(`  → ${item.text}`);
    }
    console.log();

    // ---- 测试计算器：除零错误 ----
    console.log("━━━ 测试计算器：10 / 0（期望报错）━━━");
    const divResult = await client.callTool({
      name: "calculator",
      arguments: { a: 10, b: 0, operation: "divide" },
    });
    for (const item of divResult.content) {
      if (item.type === "text") console.log(`  → ${item.text}`);
    }
    console.log();

    // ---- 测试时间工具 ----
    console.log("━━━ 测试时间工具 ━━━");
    const timeResult = await client.callTool({
      name: "get_time",
      arguments: { format: "iso" },
    });
    for (const item of timeResult.content) {
      if (item.type === "text") console.log(`  → ${item.text}`);
    }
    console.log();

    // ---- 测试回显工具 ----
    console.log("━━━ 测试回显工具 ━━━");
    const echoResult = await client.callTool({
      name: "echo",
      arguments: { message: "你好 MCP!", upper: true },
    });
    for (const item of echoResult.content) {
      if (item.type === "text") console.log(`  → ${item.text}`);
    }
    console.log();

    // ---- 列出所有资源 ----
    console.log("━━━ 资源列表 ━━━");
    const { resources } = await client.listResources();
    console.log(`服务提供了 ${resources.length} 个资源：`);
    for (const r of resources) {
      console.log(`  • ${r.name}（${r.uri}）`);
    }
    console.log();

    // ---- 读取系统信息资源 ----
    console.log("━━━ 读取系统信息资源 ━━━");
    const resourceResult = await client.readResource({
      uri: "system://info",
    });
    for (const item of resourceResult.contents) {
      if (item.text) {
        const info = JSON.parse(item.text);
        console.log(`  主机名  ：${info.hostname}`);
        console.log(`  系统    ：${info.platform}（${info.arch}）`);
        console.log(`  CPU 数  ：${info.cpus}`);
        console.log(`  内存    ：${info.freeMemory} 空闲 / ${info.totalMemory} 总计`);
        console.log(`  Node.js ：${info.nodeVersion}`);
      }
    }
    console.log();

    // ---- 列出所有提示模板 ----
    console.log("━━━ 提示模板列表 ━━━");
    const { prompts } = await client.listPrompts();
    console.log(`服务提供了 ${prompts.length} 个提示模板：`);
    for (const p of prompts) {
      console.log(`  • ${p.name}: ${p.description ?? "（无描述）"}`);
    }
    console.log();

    // ---- 测试问候提示模板 ----
    console.log("━━━ 测试问候提示模板 ━━━");
    const promptResult = await client.getPrompt({
      name: "greeting",
      arguments: { name: "World", language: "chinese", formal: "true" },
    });
    for (const msg of promptResult.messages) {
      if (msg.content.type === "text") {
        console.log(`  → [${msg.role}] ${msg.content.text}`);
      }
    }
    console.log();

    console.log("✓ 全部测试通过！");
  } catch (err) {
    console.error("测试失败：", err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
