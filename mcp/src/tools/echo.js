import { z } from "zod";

/**
 * 在 MCP 服务上注册 echo 工具
 *
 * 将输入消息原样返回
 */
export function registerEcho(server) {
  server.tool(
    "echo",
    "将输入消息回显返回",
    {
      message: z.string().describe("要回显的消息"),
      upper: z
        .boolean()
        .optional()
        .default(false)
        .describe("是否转换为大写"),
    },
    async ({ message, upper }) => {
      return {
        content: [
          {
            type: "text",
            text: upper ? message.toUpperCase() : message,
          },
        ],
      };
    },
  );
}
