import { registerSystemResource } from "./system.js";

/**
 * 在 MCP 服务上注册所有资源
 * 新增资源时在此文件添加一行即可
 */
export function registerAllResources(server) {
  registerSystemResource(server);
}
