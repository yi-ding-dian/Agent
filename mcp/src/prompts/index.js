import { registerGreetingPrompt } from "./greeting.js";

/**
 * 在 MCP 服务上注册所有 prompt
 * 新增 prompt 时在此文件添加一行即可
 */
export function registerAllPrompts(server) {
  registerGreetingPrompt(server);
}
