import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  getMcpServersConfig,
  type McpServerConfig,
} from '../config/mcp-servers-config.js';
import { config } from '../config.js';

// ─── MCP JSON-RPC 类型 ──────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

// ─── 轻量 JSON-RPC over stdio 客户端（单个 MCP server 子进程） ───

class StdioRpcClient {
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private id = 0;
  private buffer = '';
  private _process: ChildProcess;

  constructor(serverName: string, command: string, args: string[], cwd?: string) {
    // 内置 MCP 工具（如 kb_query）通过 AGENT_CONFIG_BASE_URL 调后端配置接口
    // （GET /api/agent-config/kb-link，该契约接口免鉴权）读取知识库查询链接。
    // spawn 默认透传全部环境变量；此处仅在后端进程未显式设置时按实际监听端口注入
    // （config.port 由 PORT 环境变量决定），保证任意端口部署下工具都能找到后端。
    // 用户显式设置 AGENT_CONFIG_BASE_URL 时保持原值优先。
    const env = { ...process.env };
    if (!process.env.AGENT_CONFIG_BASE_URL) {
      env.AGENT_CONFIG_BASE_URL = `http://127.0.0.1:${config.port}`;
    }
    // KB_QUERY_LINK：无需额外处理 —— env 展开天然透传所有环境变量；
    // kbQuery.js 会优先使用它（进程内直接提供链接，可绕过配置接口）。
    this._process = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this._process.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse;
          if (msg.id !== undefined) {
            const handler = this.pending.get(msg.id);
            if (handler) {
              this.pending.delete(msg.id);
              if (msg.error) {
                handler.reject(new Error(`MCP 错误: ${msg.error.message}`));
              } else {
                handler.resolve(msg.result);
              }
            }
          }
        } catch {
          // 忽略非 JSON 输出（如 console.error 日志）
        }
      }
    });

    this._process.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.log(`[MCP:${serverName}] ${msg}`);
    });

    this._process.on('exit', (code, signal) => {
      console.warn(`[MCP:${serverName}] 子进程退出 code=${code} signal=${signal}`);
      // 拒绝所有未完成的请求
      for (const [id, handler] of this.pending) {
        handler.reject(new Error(`MCP 子进程已退出 (code=${code})`));
        this.pending.delete(id);
      }
    });

    // 可执行命令不存在等启动失败：立即拒绝挂起的请求（避免 30s 超时等待）
    this._process.on('error', (err) => {
      console.warn(`[MCP:${serverName}] 子进程启动失败: ${err.message}`);
      for (const [id, handler] of this.pending) {
        handler.reject(new Error(`MCP 子进程启动失败: ${err.message}`));
        this.pending.delete(id);
      }
    });
  }

  get process(): ChildProcess {
    return this._process;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.id;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this._process.stdin!.write(JSON.stringify(req) + '\n');

      // 30 秒超时
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP 请求超时: ${method}`));
        }
      }, 30_000);
    });
  }

  /** 初始化 MCP 连接（握手协议），返回 serverInfo */
  async initialize(): Promise<{ name: string; version: string }> {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'myagent-mcp-bridge', version: '1.0.0' },
    }) as { protocolVersion: string; serverInfo: { name: string; version: string } };
    // 发送 initialized 通知
    this.request('notifications/initialized', {}).catch(() => {});
    return result.serverInfo;
  }

  /** 拉取工具列表 */
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request('tools/list') as { tools: McpToolInfo[] };
    return result.tools ?? [];
  }

  close(): void {
    this._process.kill();
  }
}

// ─── MCP 工具桥接（多 server 管理） ────────────────────────

let _bridge: McpBridge | null = null;
/** 记录初始化时的 mcp 目录（内置服务 cwd），供重建桥接复用 */
let _mcpDir: string | null = null;

/**
 * 内置服务识别：command=node 且首个参数为 mcp/src/index.js（默认内置服务配置）。
 * 内置服务工具保持原名不加前缀（兼容现有前端/对话与工具权限配置）；
 * 其余外部 server 工具统一加 mcp__<serverName>__ 前缀防工具名冲突。
 */
export function isBuiltinServer(srv: Pick<McpServerConfig, 'command' | 'args'>): boolean {
  return srv.command === 'node' && Array.isArray(srv.args) && srv.args[0] === 'mcp/src/index.js';
}

export class McpBridge {
  private mcpDir: string;
  private connections = new Map<string, StdioRpcClient>();
  private initialized = false;
  private tools: AgentTool<any>[] | null = null;

  constructor(mcpDir: string) {
    this.mcpDir = mcpDir;
  }

  /**
   * 按配置连接所有 enabled 的 MCP server 子进程并发现工具。
   * 单个 server 连接/握手失败只警告跳过，不影响其他 server。
   */
  async connect(): Promise<void> {
    const servers = getMcpServersConfig().servers.filter((s) => s.enabled);
    console.log(`[McpBridge] 开始连接 ${servers.length} 个启用的 MCP server`);

    for (const srv of servers) {
      const builtin = isBuiltinServer(srv);
      // 内置服务：默认 args 为 mcp/src/index.js（相对项目根），cwd = mcp 目录的父目录（项目根）；
      // 外部 server：默认同样使用项目根（mcp/ 下与项目根下的本地 server 可直接用相对路径，
      // 如 rag-server/index.js）；配置了 cwd 则优先使用（如 npx 全局命令不需要 cwd，
      // 相对路径基于后端进程 cwd 解析）
      const cwd = builtin ? path.resolve(this.mcpDir, '..') : srv.cwd ? path.resolve(srv.cwd) : path.resolve(this.mcpDir, '..');
      const client = new StdioRpcClient(srv.name, srv.command, srv.args, cwd);
      this.connections.set(srv.name, client);
      try {
        const info = await client.initialize();
        console.log(`[McpBridge] 已连接 MCP 服务器: ${srv.name} (${info.name} v${info.version})`);
      } catch (err) {
        console.warn(`[McpBridge] server "${srv.name}" 握手失败，跳过: ${err instanceof Error ? err.message : err}`);
        client.close();
        this.connections.delete(srv.name);
        continue;
      }
    }

    this.initialized = true;
    await this.refreshTools();
  }

  /**
   * 按最新配置重建连接（配置变更后调用）：
   * 关闭全部旧子进程，按新 server 列表重新 spawn。
   * 注意：运行中的会话持有的是创建时的工具列表，不强制热更新；重建后新建会话自动使用新工具。
   */
  async reconfigure(): Promise<void> {
    this.closeAll();
    this.tools = null;
    this.initialized = false;
    await this.connect();
  }

  private closeAll(): void {
    for (const client of this.connections.values()) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
  }

  /** 从各 server 拉取工具列表并缓存（带前缀 + 去重） */
  async refreshTools(): Promise<void> {
    if (!this.initialized) {
      this.tools = [];
      return;
    }

    const wrapped: AgentTool<any>[] = [];
    const seenNames = new Set<string>();
    const servers = getMcpServersConfig().servers.filter((s) => s.enabled);

    for (const srv of servers) {
      const client = this.connections.get(srv.name);
      if (!client) continue;
      try {
        const toolInfos = await client.listTools();
        // 内置服务工具保持原名；外部 server 工具加 mcp__<name>__ 前缀
        const prefix = isBuiltinServer(srv) ? '' : `mcp__${srv.name}__`;
        for (const tool of toolInfos) {
          const name = prefix + tool.name;
          if (seenNames.has(name)) {
            console.warn(`[McpBridge] 工具名冲突已跳过: ${name}（来自 ${srv.name}）`);
            continue;
          }
          seenNames.add(name);
          wrapped.push(this.wrapTool(client, tool, name, srv.name));
        }
        console.log(`[McpBridge] server ${srv.name}: 发现 ${toolInfos.length} 个工具${prefix ? `（前缀 ${prefix}）` : ''}`);
      } catch (err) {
        console.warn(`[McpBridge] server "${srv.name}" 拉取工具失败: ${err instanceof Error ? err.message : err}`);
      }
    }

    this.tools = wrapped;
    console.log(`[McpBridge] 共 ${wrapped.length} 个 MCP 工具可用`);
  }

  /** 获取已缓存的 MCP 工具列表（同步） */
  getCachedTools(): AgentTool<any>[] {
    return this.tools ?? [];
  }

  /** 将 MCP 工具定义包装为 AgentTool（execute 走对应 server 的连接） */
  private wrapTool(client: StdioRpcClient, mcpTool: McpToolInfo, name: string, _serverName: string): AgentTool<any> {
    return {
      name,
      label: name,
      description: mcpTool.description || '',
      parameters: mcpTool.inputSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate) => {
        const result = await client.request('tools/call', {
          name: mcpTool.name,
          arguments: params,
        }) as { content: McpContent[]; isError?: boolean };

        // MCP 返回错误时抛出
        if (result.isError) {
          const errText = (result.content || [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
          throw new Error(errText || 'MCP 工具执行失败');
        }

        // 提取文本内容
        const texts = (result.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');

        return {
          content: [{ type: 'text', text: texts || '(无返回内容)' }],
          details: {},
        };
      },
    };
  }

  /** 关闭全部 MCP 连接 */
  async close(): Promise<void> {
    this.closeAll();
    this.tools = null;
    this.initialized = false;
  }
}

// ─── 全局单例管理 ─────────────────────────────────────────

export async function initMcpBridge(mcpDir: string): Promise<McpBridge> {
  _mcpDir = mcpDir;
  const bridge = new McpBridge(mcpDir);
  await bridge.connect();
  _bridge = bridge;
  return bridge;
}

/**
 * 按最新配置重建全局桥接（配置变更后由 /api/mcp-servers 调用，fire-and-forget）。
 * 重建失败不抛出：单个 server 失败已被 connect 内部消化，整体异常仅日志。
 */
export async function rebuildMcpBridge(): Promise<void> {
  if (!_bridge) {
    // 桥接尚未初始化（如纯 API 场景）→ 按配置直接初始化
    const bridge = new McpBridge(_mcpDir ?? process.cwd());
    await bridge.connect();
    _bridge = bridge;
    return;
  }
  await _bridge.reconfigure();
}

export function getMcpBridge(): McpBridge | null {
  return _bridge;
}
