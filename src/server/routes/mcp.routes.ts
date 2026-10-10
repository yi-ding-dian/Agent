import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  loadMcpServersConfig,
  getMcpServersConfig,
  addMcpServer,
  updateMcpServer,
  deleteMcpServer,
} from '../config/mcp-servers-config.js';
import { rebuildMcpBridge } from '../services/mcp-bridge.js';

/**
 * MCP 外部 server 管理 API（统一经 /api 前缀 + auth 中间件认证，见 app.ts）
 *
 * GET    /api/mcp-servers        服务器列表（含 enabled）
 * POST   /api/mcp-servers        新增（body: name/command/args/description）
 * PUT    /api/mcp-servers/:name  更新（enabled 开关/编辑 command/args/description；name 不可改）
 * DELETE /api/mcp-servers/:name  删除
 *
 * 全部落盘 data/mcp-servers.json，校验失败返回 400 中文错误信息。
 * 变更成功后触发桥接重建（rebuildMcpBridge，fire-and-forget）：
 * 运行中会话不强制热更新，新建会话自动使用新配置的工具。
 */
export const mcpRouter = Router();

// 启动时从文件加载 MCP server 配置
loadMcpServersConfig();

// 配置变更后异步重建桥接（失败仅日志，不影响 API 响应）
function refreshBridge(): void {
  void rebuildMcpBridge().catch((err: unknown) => {
    console.warn(`[McpRoutes] 桥接重建失败: ${err instanceof Error ? err.message : err}`);
  });
}

mcpRouter.get('/mcp-servers', (_req: Request, res: Response): void => {
  try {
    res.json(getMcpServersConfig());
  } catch (err: any) {
    res.status(500).json({ error: `读取 MCP server 配置失败: ${err.message}` });
  }
});

mcpRouter.post('/mcp-servers', (req: Request, res: Response): void => {
  try {
    const body = req.body as Record<string, unknown>;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: '请求体必须是 JSON 对象' });
      return;
    }
    const { config: cfg, errors } = addMcpServer(body);
    if (errors.length > 0) {
      res.status(400).json({ error: `新增 MCP 服务校验失败：${errors.join('；')}` });
      return;
    }
    refreshBridge();
    res.json(cfg);
  } catch (err: any) {
    res.status(500).json({ error: `新增 MCP 服务失败: ${err.message}` });
  }
});

mcpRouter.put('/mcp-servers/:name', (req: Request, res: Response): void => {
  try {
    const name = String(req.params.name);
    const body = req.body as Record<string, unknown>;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: '请求体必须是 JSON 对象' });
      return;
    }
    const { config: cfg, errors, found } = updateMcpServer(name, body);
    if (!found) {
      res.status(404).json({ error: `MCP 服务 "${name}" 不存在` });
      return;
    }
    if (errors.length > 0) {
      res.status(400).json({ error: `更新 MCP 服务校验失败：${errors.join('；')}` });
      return;
    }
    refreshBridge();
    res.json(cfg);
  } catch (err: any) {
    res.status(500).json({ error: `更新 MCP 服务失败: ${err.message}` });
  }
});

mcpRouter.delete('/mcp-servers/:name', (req: Request, res: Response): void => {
  try {
    const name = String(req.params.name);
    const { config: cfg, found } = deleteMcpServer(name);
    if (!found) {
      res.status(404).json({ error: `MCP 服务 "${name}" 不存在` });
      return;
    }
    refreshBridge();
    res.json(cfg);
  } catch (err: any) {
    res.status(500).json({ error: `删除 MCP 服务失败: ${err.message}` });
  }
});
