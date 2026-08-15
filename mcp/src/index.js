import server from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";
import { registerAllPrompts } from "./prompts/index.js";

// 注册所有能力
registerAllTools(server);
registerAllResources(server);
registerAllPrompts(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP 服务已通过 stdio 启动");
}

main().catch((err) => {
  console.error("致命错误：", err);
  process.exit(1);
});
