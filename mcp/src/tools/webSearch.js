import { z } from "zod";

export function registerWebSearch(server) {
  server.tool(
    "web_search",
    "使用 Tavily 搜索引擎搜索网页，返回相关的摘要和链接",
    {
      query: z.string().describe("搜索关键词"),
      search_depth: z
        .enum(["basic", "advanced"])
        .default("basic")
        .describe("搜索深度，basic 返回摘要，advanced 返回更详细内容"),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("返回结果数量，最多 10 条"),
    },
    async ({ query, search_depth, max_results }) => {
      // API Key 从环境变量读取，禁止硬编码（避免密钥泄漏）
      const apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "Tavily API key 未配置（设置环境变量 TAVILY_API_KEY）" }],
          isError: true,
        };
      }

      try {
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            query,
            search_depth,
            max_results,
            include_answer: false, // 不包含直接答案，只返回搜索结果
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [{ type: "text", text: `Tavily API 错误 (${response.status}): ${errorText}` }],
            isError: true,
          };
        }

        const data = await response.json();

        // 构造返回文本，清晰列出每个结果
        let resultText = `搜索“${query}”的结果：\n\n`;
        if (!data.results || data.results.length === 0) {
          resultText += "未找到相关结果。";
        } else {
          data.results.forEach((item, index) => {
            resultText += `${index + 1}. ${item.title}\n`;
            resultText += `   URL: ${item.url}\n`;
            resultText += `   摘要: ${item.content}\n\n`;
          });
        }

        return {
          content: [{ type: "text", text: resultText }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `搜索请求失败: ${error.message}` }],
          isError: true,
        };
      }
    },
  );
}