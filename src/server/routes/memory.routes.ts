import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getMemory,
  setMemory,
  distillMemory,
  buildDistillLlmCall,
} from '../services/memory-service.js';

/**
 * 跨会话记忆管理 API（统一经 /api 前缀 + auth 中间件认证，见 app.ts）
 *
 * GET  /api/memory        返回当前记忆全文（文件未创建时返回空字符串）
 * POST /api/memory        整文件覆盖保存；body { content: string }，空 content 表示清空
 * POST /api/memory/distill 手动触发记忆蒸馏（body 空）；返回 { success, distilled, result, summary?/error? }
 *                          LLM 不可用或输出异常时 success=false 且不修改原记忆
 */
export const memoryRouter = Router();

memoryRouter.get('/memory', (_req: Request, res: Response): void => {
  try {
    res.json({ content: getMemory() });
  } catch (err: any) {
    res.status(500).json({ error: `读取记忆失败: ${err.message}` });
  }
});

memoryRouter.post('/memory', (req: Request, res: Response): void => {
  try {
    const body = req.body as { content?: unknown };
    if (typeof body.content !== 'string') {
      res.status(400).json({ error: 'content 必须为字符串' });
      return;
    }
    setMemory(body.content);
    res.json({ status: 'success' });
  } catch (err: any) {
    res.status(500).json({ error: `保存记忆失败: ${err.message}` });
  }
});

// POST /api/memory/distill — 手动触发记忆蒸馏（body 空）
memoryRouter.post('/memory/distill', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await distillMemory(buildDistillLlmCall());
    if (!result.success) {
      res.status(502).json({ success: false, error: result.error });
      return;
    }
    res.json({
      success: true,
      distilled: result.distilled,
      result: result.result,
      summary: result.summary,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: `记忆蒸馏失败: ${err.message}` });
  }
});
