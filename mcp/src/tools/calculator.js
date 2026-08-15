import { z } from "zod";

/** 四则运算映射 */
const OPERATIONS = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => (b === 0 ? NaN : a / b),
};

/**
 * 在 MCP 服务上注册 calculator 工具
 *
 * 支持：加、减、乘、除
 */
export function registerCalculator(server) {
  server.tool(
    "calculator",
    "执行加减乘除四则运算",
    {
      a: z.number().describe("第一个数字"),
      b: z.number().describe("第二个数字"),
      operation: z
        .enum(["add", "subtract", "multiply", "divide"])
        .describe("要执行的运算：add（加）、subtract（减）、multiply（乘）、divide（除）"),
    },
    async ({ a, b, operation }) => {
      const fn = OPERATIONS[operation];
      const result = fn(a, b);

      if (!Number.isFinite(result)) {
        return {
          content: [{ type: "text", text: `错误：不能除以零` }],
          isError: true,
        };
      }

      const 运算符 = { add: "+", subtract: "-", multiply: "*", divide: "/" };
      return {
        content: [
          {
            type: "text",
            text: `${a} ${运算符[operation]} ${b} = ${result}`,
          },
        ],
      };
    },
  );
}
