import { z } from "zod";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

/**
 * 个人文件管理系统查询工具（file_search / file_read / file_download）
 *
 * 供 MyAgent 内置工具注册（mcp/src/tools/fileQuery.js），使用方式：
 *   import { registerFileQuery } from "./tools/fileQuery.js";
 *   registerFileQuery(server);   // tools/index.js 注册一行
 *
 * 配置获取（方案 A，同 kbQuery）：
 *   工具运行时优先环境变量，否则调 Agent 后端配置接口获取"文件系统查询链接"
 *   （界面「设置 → 外部服务」配置存数据库，天然适配镜像部署），接口契约：
 *     GET {AGENT_CONFIG_BASE_URL}/api/agent-config/filesys-link
 *     → 200 { "link": "http://host:port?token=sk-xxx" }（或 http://host:port/sk-xxx）
 *     → 未配置 404 { "detail": "未配置文件系统查询链接" }
 *   AGENT_CONFIG_BASE_URL 环境变量由 Agent spawn MCP 时按实际端口注入（见 mcp-bridge.ts）。
 *
 * 兼容（向后）环境变量，优先级高于接口配置：
 *   方式一（推荐，单条完整配置）：FILESYS_URL
 *     FILESYS_URL=http://127.0.0.1:5001/sk-xxx...
 *     （地址与 API Token 合成一条；也兼容 ?token=sk-xxx 查询参数形式）
 *   方式二（分开配置）：
 *     FILESYS_BASE_URL  文件管理系统地址（默认 http://127.0.0.1:5001）
 *     FILESYS_API_TOKEN 设置页「Agent API 接入」生成的 sk-... 密钥
 *
 * 依赖文件管理系统已配置 Embedding API（设置页），搜索为语义搜索，
 * 支持自然语言提问；必要时 Agent 先 file_read 读全文再回答用户。
 */

const DEFAULT_CONFIG_BASE = "http://127.0.0.1:7980";
const DEFAULT_BASE = "http://127.0.0.1:5001";
const TIMEOUT_MS = 30_000;
const SNIPPET_MAX_LEN = 2000;
const CONTENT_MAX_LEN = 6000;

/** 解析完整配置串：base 与 token 合成一条 */
export function parseFileSysUrl(urlStr) {
  const url = new URL(urlStr);
  let token = url.searchParams.get("token") || url.searchParams.get("api_key") || "";
  if (!token) {
    // 路径段形式：http://host:port/sk-xxx
    const seg = url.pathname.split("/").filter(Boolean);
    const last = seg[seg.length - 1] || "";
    if (last.startsWith("sk-")) token = last;
  }
  if (!token) {
    throw new Error("文件系统查询链接缺少 token（格式应为 http://host:port/sk-xxx 或带 ?token=sk-xxx）");
  }
  return { base: url.origin, token };
}

/** 从 Agent 配置接口获取文件系统查询链接（方案 A） */
async function fetchFileSysLink() {
  const base = process.env.AGENT_CONFIG_BASE_URL || DEFAULT_CONFIG_BASE;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(`${base.replace(/\/$/, "")}/api/agent-config/filesys-link`, {
      signal: ctrl.signal,
    });
    if (resp.status === 404) {
      throw new Error("未配置文件系统查询链接，请在设置→外部服务中填写");
    }
    if (!resp.ok) {
      throw new Error(`配置接口错误 (${resp.status})`);
    }
    const data = await resp.json();
    if (!data?.link) throw new Error("配置接口返回缺少 link 字段");
    return data.link;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("读取文件系统配置超时");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 从环境变量或 Agent 配置接口读取配置（env 优先，向后兼容） */
async function fetchFileSysConfig() {
  // 环境变量（兼容）：完整配置或分开配置
  if (process.env.FILESYS_URL) {
    return parseFileSysUrl(process.env.FILESYS_URL);
  }
  const base = process.env.FILESYS_BASE_URL || "";
  const token = process.env.FILESYS_API_TOKEN || "";
  if (base || token) {
    if (!token) {
      throw new Error("未配置文件管理系统 API Token（请在设置页生成）");
    }
    return { base: base.replace(/\/$/, "") || DEFAULT_BASE, token };
  }
  // 方案 A：调 Agent 后端配置接口
  const link = await fetchFileSysLink();
  return parseFileSysUrl(link);
}

/** 调文件管理系统 Agent 接口 */
async function requestFileSys(path, params, timeout = TIMEOUT_MS) {
  const { base, token } = await fetchFileSysConfig();
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 401) {
      throw new Error("API Token 无效或已吊销（请到设置页重新生成）");
    }
    if (resp.status === 404) {
      throw new Error("未找到对应文件");
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`文件系统接口错误 (${resp.status})${detail ? `: ${detail}` : ""}`);
    }
    return await resp.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("文件系统接口超时");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 搜索结果格式化（仿 kb_query 的来源格式；不含内容片段，省 Agent token） */
function formatSearchResults(results, query) {
  if (!results?.length) return `未在文件系统中搜索到与「${query}」相关的内容。`;
  let text = `文件系统语义搜索「${query}」命中 ${results.length} 条：\n\n`;
  results.forEach((r, i) => {
    const name = r.name || "未知";
    const moduleName = r.module_name ? `（${r.module_name}）` : "";
    const score = r.score != null ? `，匹配 ${Math.round(r.score * 100)}%` : "";
    text += `${i + 1}. ${name}${moduleName}${score}\n`;
    if (r.type === "file") {
      text += `   [文件] 读内容: file_read(target_id=${r.target_id})　下载: file_download(target_id=${r.target_id}, type="file")\n`;
    } else if (r.type === "profile") {
      text += `   [资料] 读内容: file_read(target_id=${r.target_id}, type="profile")　下载: file_download(target_id=${r.target_id}, type="profile")\n`;
    }
    text += "\n";
  });
  return text;
}

/**
 * 在 MCP 服务上注册文件系统工具
 */
export function registerFileQuery(server) {
  // 工具 1：语义搜索文件（含相关句片段、下载链接）
  server.tool(
    "file_search",
    "在个人文件管理系统按语义搜索文件与资料（支持自然语言），返回匹配结果与相关句片段",
    {
      query: z.string().describe("搜索问题（自然语言，如：版本控制冲突怎么解决）"),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("返回结果数量，最多 10 条"),
    },
    async ({ query, top_k }) => {
      try {
        const data = await requestFileSys("/api/agent/search", { q: query });
        const text = formatSearchResults(data.results, query);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `文件系统查询失败: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // 工具 2：读取文本内容（文件或资料，Agent 深读用）
  server.tool(
    "file_read",
    "读取文件管理系统中的文本内容（文件或资料全文前 1000 字符；通过 file_search 返回的 target_id / type 调用）",
    {
      target_id: z.number().int().describe("目标 ID（来自 file_search 结果的 target_id 字段）"),
      type: z
        .enum(["file", "profile"])
        .default("file")
        .describe("目标类型（来自 file_search 结果的 type 字段：file=文件 / profile=资料）"),
    },
    async ({ target_id, type }) => {
      try {
        const url = type === "profile"
          ? `/api/agent/profile/${target_id}/content`
          : `/api/agent/files/${target_id}/content`;
        const data = await requestFileSys(url);
        let text = `文件: ${data.name}\n\n${data.content || ""}`;
        if (data.truncated) text += "\n\n（内容较长，已截断前 8000 字符）";
        if (text.length > CONTENT_MAX_LEN) text = `${text.slice(0, CONTENT_MAX_LEN)}…（已截断）`;
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `文件读取失败: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // 工具 3：下载文件/资料到本地磁盘
  server.tool(
    "file_download",
    "下载文件管理系统中的文件或资料（Markdown/文本）到本地磁盘（通过 file_search 返回的 target_id / type 调用）",
    {
      target_id: z.number().int().describe("目标 ID（来自 file_search 结果的 target_id 字段）"),
      type: z
        .enum(["file", "profile"])
        .default("file")
        .describe("目标类型（file=文件 / profile=资料，来自搜索结果 type 字段）"),
      save_path: z
        .string()
        .optional()
        .describe("保存目录（可选，默认用户下载目录 ~/Downloads）"),
    },
    async ({ target_id, type, save_path }) => {
      try {
        const { base, token } = await fetchFileSysConfig();
        const url = type === "profile"
          ? `${base}/api/agent/profile/${target_id}/download`
          : `${base}/api/agent/files/${target_id}/download`;
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.status === 401) {
          throw new Error("API Token 无效或已吊销（请到设置页重新生成）");
        }
        if (resp.status === 404) {
          throw new Error("未找到对应文件");
        }
        if (!resp.ok) {
          const detail = await resp.text().catch(() => "");
          throw new Error(`文件下载失败 (${resp.status})${detail ? `: ${detail}` : ""}`);
        }
        // 从 Content-Disposition 解析真实文件名（优先 RFC5987 filename* 中文名）
        const cd = resp.headers.get("content-disposition") || "";
        const mUtf8 = cd.match(/filename\*=UTF-8''([^;]+)/i);
        const mFallback = cd.match(/filename="?([^";]+)"?/i);
        let filename = mUtf8 ? decodeURIComponent(mUtf8[1]) : (mFallback ? mFallback[1] : `item_${target_id}`);
        const dir = save_path || path.join(os.homedir(), "Downloads");
        await fs.mkdir(dir, { recursive: true });
        const dest = path.join(dir, filename);
        const buf = Buffer.from(await resp.arrayBuffer());
        await fs.writeFile(dest, buf);
        return {
          content: [
            {
              type: "text",
              text:
                `文件已下载到本地：\n` +
                `  路径: ${dest}\n` +
                `  文件名: ${filename}\n` +
                `  大小: ${(buf.length / 1024).toFixed(1)} KB`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `文件下载失败: ${error.message}` }],
          isError: true,
        };
      }
    },
  );
}
