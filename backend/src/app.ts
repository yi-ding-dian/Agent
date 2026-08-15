import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { apiRouter } from './routes/index.js';
import { agentConfigRouter } from './routes/external-service.routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { createAuthRouter } from './auth/index.js';
import { createAuthMiddleware } from './auth/index.js';
import { createAdminRouter } from './admin/admin.routes.js';

export function createApp(frontendDir: string) {
  const app = express();

  app.use(cors());
  // 增大 JSON body 限制以支持图片上传（base64 编码后体积膨胀约 33%）
  // 前端允许最大 10MB 图片，加上多张图片和历史消息，50MB 比较合理
  app.use(express.json({ limit: '50mb' }));
  app.use(requestLogger);

  // 1. 认证路由（无需登录）
  app.use('/api', createAuthRouter());

  // 1.5 知识库查询链接契约路由（免鉴权，供 MCP 工具进程无鉴权头调用，与 /health 同级放行）
  //     风险：返回的链接本身含 token，可访问知识库；仅建议内网部署使用。
  //     更安全的方式：用 KB_QUERY_LINK 环境变量向工具进程直供链接，勿暴露该接口。
  app.use('/api/agent-config', agentConfigRouter);

  // 2. 认证中间件（保护后续 /api/* 路由）
  app.use('/api', createAuthMiddleware());

  // 3. 管理员 API
  app.use('/api', createAdminRouter());

  // 4. 业务 API（chat、session、config 等）
  app.use('/api', apiRouter);

  // 5. 管理员页面
  const adminHtmlPath = path.resolve(process.cwd(), 'public', 'admin.html');
  app.get('/admin', (_req, res) => {
    if (fs.existsSync(adminHtmlPath)) {
      res.sendFile(adminHtmlPath);
    } else {
      res.status(404).send('管理员页面未找到');
    }
  });

  // 6. 前端静态文件（React 编译产物）
  if (fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir));
    app.get(/^(?!\/(api|admin|health)).*/, (_req, res) => {
      res.sendFile(path.join(frontendDir, 'index.html'));
    });
  }

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(errorHandler);

  return app;
}
