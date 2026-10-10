/**
 * 知识库资源透传代理（免鉴权挂载，见 app.ts 挂载处注释）
 *
 * GET /api/ext/*  →  转发到配置的知识库 origin（data/external-service-config.json 的 kb 条目）
 *                    路径原样保留，token 一律以配置里的当前值为准（见下）
 *
 * 背景：知识库返回的文档 Markdown 中，图片是相对路径
 *   /api/ext/{id}/images/{docId}/{name}.png?token=xxx
 * AI 原样转述进回复后，浏览器按「当前源」解析该相对路径 → 打到本服务
 * （无此路由 → 鉴权中间件 401 / SPA fallback）→ 图片全部破图。
 * 本路由补上「相对路径 → 知识库服务」这一跳。
 *
 * token 处理：请求带的 token 一律以配置里的当前值为准（configId 一致时替换）
 *  - kb_query 工具返回给模型前已剥掉 token（mcp/src/tools/kbQuery.js），对话记录里不留密钥
 *  - 顺带兜住 token 轮换：历史回复里存的旧 token 自动用新值覆盖
 *
 * 安全性：
 *  - 目标 origin 严格取自配置（非请求参数），上游路径前缀固定为 /api/ext，杜绝开放代理 / SSRF
 *  - 免鉴权原因：<img> 标签发出的请求不携带 Authorization 头（前端 token 存 localStorage，
 *    见 frontend/src/services/api.ts）→ 不豁免必然 401；其保护级别等同知识库自身（token 由本服务补，由知识库校验）
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getServiceEntryById } from '../external/config.js';

export const extProxyRouter = Router();

/** 上游超时（毫秒）：图片体积不确定，给足余量 */
const UPSTREAM_TIMEOUT_MS = 15_000;

/** 单次响应体积上限（字节）：超限拒绝，避免大文件把内存打爆 */
const MAX_BYTES = 20 * 1024 * 1024;

/** 浏览器缓存时长（秒）：token 有有效期，缓存过长会导致失效后仍用旧图 */
const CLIENT_CACHE_SECONDS = 300;

/** 取知识库 origin 与配置凭据；未配置或链接非法返回 null */
function getKbTarget(): { origin: string; configId: string; token: string } | null {
  const raw = getServiceEntryById('kb')?.url;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // 配置形如 http://host:8091/ext-query/<configId>?token=xxx
    const configId = url.pathname.split('/').filter(Boolean)[1] ?? '';
    return { origin: url.origin, configId, token: url.searchParams.get('token') ?? '' };
  } catch {
    return null;
  }
}

// 用 router.use 而非通配路由：项目为 Express 5，通配符语法与 4.x 不兼容（'/*' 会直接抛错）
extProxyRouter.use(async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: '仅支持 GET / HEAD' });
    return;
  }

  const kb = getKbTarget();
  if (!kb) {
    res.status(503).json({ error: '未配置知识库查询链接，无法加载知识库资源' });
    return;
  }

  // req.originalUrl 形如 /api/ext/{id}/images/{docId}/{name}.png?token=xxx
  // 凭据一律以配置里的当前 token 为准：AI 回复里的地址可能不带 token
  // （kb_query 返回时刻意剥掉，见 mcp/src/tools/kbQuery.js），也可能带的是轮换前的旧 token
  // 仅当请求的 configId 与配置一致时替换，不给其他知识库的地址硬塞凭据
  const [reqPath, reqQuery = ''] = req.originalUrl.split('?');
  const params = new URLSearchParams(reqQuery);
  const reqConfigId = reqPath.split('/').filter(Boolean)[2] ?? '';
  if (kb.token && reqConfigId === kb.configId) params.set('token', kb.token);
  const query = params.toString();
  const target = `${kb.origin}${reqPath}${query ? `?${query}` : ''}`;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    // 先看声明长度，避免把超大文件读进内存后再拒绝
    const declaredLength = Number(upstream.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_BYTES) {
      res.status(502).json({ error: '知识库资源过大，已拒绝转发' });
      return;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.byteLength > MAX_BYTES) {
      res.status(502).json({ error: '知识库资源过大，已拒绝转发' });
      return;
    }

    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (upstream.ok) {
      res.setHeader('Cache-Control', `private, max-age=${CLIENT_CACHE_SECONDS}`);
    }
    res.status(upstream.status).send(body);
  } catch (e: any) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      res.status(504).json({ error: '知识库响应超时' });
      return;
    }
    res.status(502).json({ error: `知识库资源加载失败: ${e?.message ?? '网络错误'}` });
  }
});
