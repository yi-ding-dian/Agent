/**
 * 外部服务配置 API（知识库查询链接 + 文件系统查询链接；统一经 /api 前缀 + auth 中间件认证，见 app.ts）
 *
 * GET  /api/external-service        获取当前配置 { kbQueryUrl, filesysUrl }
 * POST /api/external-service        保存（body: { kbQueryUrl?, filesysUrl? }；空串=清除，非空校验 URL）
 * POST /api/external-service/test   测试连接（body: { kbQueryUrl? , filesysUrl? }，允许测试未保存的值）
 *
 * 配置持久化到 data/external-service-config.json（config.dataDir，可挂外部卷），保存后即时生效（无缓存）。
 *
 * 链接解析规则（测试连接）：
 *   kbQueryUrl：new URL(kbQueryUrl) → origin = url.origin
 *   id    = pathname 最后一段（如 /ext-query/d29eb7564db3 → d29eb7564db3）
 *   token = searchParams.get('token')
 *   测试请求：GET {origin}/api/ext/{id}/info?token={token}，8 秒超时（AbortSignal.timeout）
 *   结果：200 → 可用；401 → 链接无效；其他状态/网络错误 → 分类中文错误
 *   filesysUrl：origin + token 解析后测 GET {origin}/api/agent/search?q=ping（Bearer token），8 秒超时
 *
 * agentConfigRouter：知识库查询链接契约（GET /kb-link）与文件系统查询链接契约（GET /filesys-link），
 * 免鉴权挂载于 app.ts，供 MCP 工具进程无鉴权读取；未配置返回 404。风险见 app.ts 挂载处注释。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  loadExternalServiceConfig,
  getExternalServiceConfig,
  saveExternalServiceConfig,
  validateKbQueryUrl,
  validateFileSysUrl,
  parseFilesysLink,
} from '../config/external-service-config.js';

export const externalServiceRouter = Router();

// 启动时从文件加载外部服务配置
loadExternalServiceConfig();

/** 解析查询链接 → { origin, id, token }；格式不正确返回 null */
function parseKbQueryUrl(raw: string): { origin: string; id: string; token: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // 要求 /ext-query/<id> 结构（至少 2 段路径）；id = pathname 最后一段
  // 如 /ext-query/d29eb7564db3 → id=d29eb7564db3；仅 /ext-query 视为缺 id
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const id = segments[segments.length - 1] ?? '';
  const token = url.searchParams.get('token') ?? '';
  if (!id || !token) return null;
  return { origin: url.origin, id, token };
}

externalServiceRouter.get('/external-service', (_req: Request, res: Response): void => {
  try {
    res.json(getExternalServiceConfig());
  } catch (err: any) {
    res.status(500).json({ error: `读取外部服务配置失败: ${err.message}` });
  }
});

externalServiceRouter.post('/external-service', (req: Request, res: Response): void => {
  try {
    const body = req.body as Record<string, unknown>;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: '请求体必须是 JSON 对象' });
      return;
    }
    const { config: cfg, errors } = saveExternalServiceConfig(body);
    if (errors.length > 0) {
      res.status(400).json({ error: `外部服务配置保存失败：${errors.join('；')}` });
      return;
    }
    res.json(cfg);
  } catch (err: any) {
    res.status(500).json({ error: `保存外部服务配置失败: ${err.message}` });
  }
});

externalServiceRouter.post('/external-service/test', async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // 文件系统链接测试：body.filesysUrl 存在时走该分支
  const hasFilesys = typeof body.filesysUrl === 'string' && body.filesysUrl.trim() !== '';
  // 知识库链接测试：body.kbQueryUrl（兼容旧前端；与 filesys 同时传入时优先 kb，仅一种时按传入）
  const hasKb = typeof body.kbQueryUrl === 'string' && body.kbQueryUrl.trim() !== '';

  if (hasKb) {
    const kbQueryUrl = body.kbQueryUrl as string;
    if (validateKbQueryUrl(kbQueryUrl) !== null) {
      res.status(400).json({ ok: false, error: '链接格式不正确，应为 http://host/ext-query/<id>?token=xxx' });
      return;
    }
    const parsed = parseKbQueryUrl(kbQueryUrl);
    if (!parsed) {
      res.status(400).json({ ok: false, error: '链接格式不正确，应为 http://host/ext-query/<id>?token=xxx' });
      return;
    }

    const start = Date.now();
    try {
      const resp = await fetch(
        `${parsed.origin}/api/ext/${encodeURIComponent(parsed.id)}/info?token=${encodeURIComponent(parsed.token)}`,
        { signal: AbortSignal.timeout(8000) },
      );
      const latencyMs = Date.now() - start;

      if (resp.status === 200) {
        res.json({ ok: true, latencyMs });
        return;
      }
      if (resp.status === 401) {
        res.json({ ok: false, latencyMs, error: '链接无效（HTTP 401）' });
        return;
      }
      // 其他状态码分类提示（参考 test-model-connection 的错误分类风格）
      const statusMap: Record<number, string> = {
        400: '请求被拒绝（参数可能不正确）',
        403: '无访问权限',
        404: '查询接口不存在（路径或服务地址可能不正确）',
        429: '请求过于频繁（限流）',
        500: '外部服务内部错误',
        502: '外部服务网关错误',
        503: '外部服务暂不可用',
        504: '外部服务网关超时',
      };
      const head = statusMap[resp.status]
        ? `${statusMap[resp.status]}（HTTP ${resp.status}）`
        : `外部服务返回 HTTP ${resp.status}`;
      res.json({ ok: false, latencyMs, error: head });
      return;
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        res.json({ ok: false, error: '连接超时（8 秒），请检查网络或服务地址' });
        return;
      }
      outKbNetError(res, e);
      return;
    }
  }

  if (hasFilesys) {
    const filesysUrl = body.filesysUrl as string;
    if (validateFileSysUrl(filesysUrl) !== null) {
      res.status(400).json({ ok: false, error: '链接格式不正确，应为 http://host:port?token=sk-xxx 或 http://host:port/sk-xxx' });
      return;
    }
    const parsed = parseFilesysLink(filesysUrl);
    if (!parsed) {
      res.status(400).json({ ok: false, error: '链接格式不正确，应为 http://host:port?token=sk-xxx 或 http://host:port/sk-xxx' });
      return;
    }

    const start = Date.now();
    try {
      // 轻量试探：搜索接口带 q=ping（Bearer token）
      const resp = await fetch(`${parsed.base}/api/agent/search?q=ping`, {
        headers: { Authorization: `Bearer ${parsed.token}` },
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - start;
      if (resp.status === 200) {
        res.json({ ok: true, latencyMs });
        return;
      }
      if (resp.status === 401) {
        res.json({ ok: false, latencyMs, error: 'API Token 无效或已吊销（请重新生成）' });
        return;
      }
      const statusMap: Record<number, string> = {
        400: '请求被拒绝（参数可能不正确）',
        403: '无访问权限',
        404: '查询接口不存在（路径或服务地址可能不正确）',
        429: '请求过于频繁（限流）',
        500: '文件管理系统内部错误',
        502: '文件管理系统网关错误',
        503: '文件管理系统暂不可用',
      };
      const head = statusMap[resp.status]
        ? `${statusMap[resp.status]}（HTTP ${resp.status}）`
        : `文件管理系统返回 HTTP ${resp.status}`;
      res.json({ ok: false, latencyMs, error: head });
      return;
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        res.json({ ok: false, error: '连接超时（8 秒），请检查网络或服务地址' });
        return;
      }
      outKbNetError(res, e);
      return;
    }
  }

  // 两种情况都没有 -> 400
  res.status(400).json({ ok: false, error: '请提供 kbQueryUrl 或 filesysUrl 链接' });
});

/** 网络错误分类输出（KB 与 filesys 测试共用） */
function outKbNetError(res: Response, e: any): void {
  // 网络错误分类（undici/Node fetch 的 cause 携带底层码）
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : '';
  const netErrors: Record<string, string> = {
    ENOTFOUND: '服务地址无法解析（DNS 失败）',
    ECONNREFUSED: '连接被拒绝（服务未启动或端口不正确）',
    ECONNRESET: '连接被重置',
    ETIMEDOUT: '连接超时',
    EHOSTUNREACH: '主机不可达',
    EAI_AGAIN: '服务地址解析超时（DNS）',
  };
  const head = netErrors[code] || '网络错误';
  res.json({ ok: false, error: `无法连接到外部服务：${head}（${code || '连接失败'}）` });
}

/**
 * 知识库查询链接契约路由（免鉴权，供 MCP 工具进程调用，见 app.ts 挂载处注释）
 *
 * GET /api/agent-config/kb-link
 *   → 200 { link: <kbQueryUrl> }        已配置
 *   → 404 { detail: "未配置知识库查询链接" }   未配置（空串）
 */
export const agentConfigRouter = Router();

agentConfigRouter.get('/kb-link', (_req: Request, res: Response): void => {
  try {
    const { kbQueryUrl } = getExternalServiceConfig();
    if (!kbQueryUrl) {
      res.status(404).json({ detail: '未配置知识库查询链接' });
      return;
    }
    res.json({ link: kbQueryUrl });
  } catch (err: any) {
    res.status(500).json({ detail: `读取知识库查询链接失败: ${err.message}` });
  }
});

agentConfigRouter.get('/filesys-link', (_req: Request, res: Response): void => {
  try {
    const { filesysUrl } = getExternalServiceConfig();
    if (!filesysUrl) {
      res.status(404).json({ detail: '未配置文件系统查询链接' });
      return;
    }
    res.json({ link: filesysUrl });
  } catch (err: any) {
    res.status(500).json({ detail: `读取文件系统查询链接失败: ${err.message}` });
  }
});
