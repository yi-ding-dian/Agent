import { z } from "zod";

/**
 * 在 MCP 服务上注册 get_time 工具
 *
 * 获取当前时间或将 unix 时间戳转换为可读格式
 */
export function registerTimeTool(server) {
  server.tool(
    "get_time",
    "获取当前日期时间或转换 unix 时间戳为可读格式",
    {
      timestamp: z
        .number()
        .optional()
        .describe("可选的 unix 时间戳（自 epoch 以来的秒数）"),
      format: z
        .enum(["iso", "locale", "unix"])
        .optional()
        .default("iso")
        .describe("输出格式：iso（标准格式）、locale（本地格式）、unix（时间戳）"),
    },
    async ({ timestamp, format }) => {
      const date = timestamp ? new Date(timestamp * 1000) : new Date();
      let text;

      switch (format) {
        case "iso":
          text = date.toISOString();
          break;
        case "locale":
          text = date.toLocaleString();
          break;
        case "unix":
          text = String(Math.floor(date.getTime() / 1000));
          break;
        default:
          text = date.toISOString();
      }

      return {
        content: [
          {
            type: "text",
            text: timestamp
              ? `时间戳 ${timestamp} → ${text}`
              : `当前时间：${text}`,
          },
        ],
      };
    },
  );
}
