import { z } from "zod";

/**
 * 在 MCP 服务上注册 greeting prompt
 *
 * 生成多语言问候消息
 */
export function registerGreetingPrompt(server) {
  server.prompt(
    "greeting",
    "生成个性化问候语",
    {
      name: z.string().describe("被问候者的姓名"),
      language: z
        .enum(["english", "chinese", "japanese"])
        .optional()
        .default("english")
        .describe("问候语言：english（英语）、chinese（中文）、japanese（日语）"),
      formal: z
        .enum(["true", "false"])
        .optional()
        .default("false")
        .describe("是否使用正式语气（true/false）"),
    },
    async ({ name, language, formal }) => {
      const isFormal = formal === "true";
      const greetings = {
        english: isFormal ? "Good day" : "Hello",
        chinese: isFormal ? "您好" : "你好",
        japanese: isFormal ? "こんにちは" : "やあ",
      };

      const greeting = greetings[language];
      const message = `${greeting}, ${name}!`;

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: message,
            },
          },
        ],
      };
    },
  );
}
