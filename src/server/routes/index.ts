/**
 * 路由统一挂载点
 *
 * 新增路由请按此清单步骤操作（详见 README「开发指南 · 新增 API」）：
 *   1. 在 backend/src/routes/ 新建 <name>.routes.ts，导出 xxxRouter
 *   2. 在本文件 import 并 apiRouter.use(xxxRouter)
 *   3. 路由内必须经过 auth 中间件（见 auth/index.ts 在 app.ts 中的挂载顺序）
 *   4. 前端在 frontend/src/services/api.ts（或 api-config.ts）添加封装
 *   5. 更新 README「API 接口」表
 */
import { Router } from 'express';
import { chatRouter } from '../chat/routes.js';
import { executeRouter } from '../chat/execute.routes.js';
import { sessionRouter } from '../session/routes.js';
import { abortRouter } from '../chat/abort.routes.js';
import { subagentRouter } from '../agent/subagent.routes.js';
import { configRouter } from '../setting/routes.js';
import { confirmationRouter } from '../chat/confirmation.routes.js';
import { utilsRouter } from './utils.routes.js';
import { tokenRouter } from '../token/routes.js';
import { steerRouter } from '../chat/steer.routes.js';
import { syncRouter } from '../chat/sync.routes.js';
import { memoryRouter } from '../memory/routes.js';
import { mcpRouter } from '../mcp/routes.js';
import { externalServiceRouter } from '../external/routes.js';
import { extensionsRouter } from '../extension/routes.js';

export const apiRouter = Router();
apiRouter.use(chatRouter);
apiRouter.use(executeRouter);
apiRouter.use(sessionRouter);
apiRouter.use(abortRouter);
apiRouter.use(subagentRouter);
apiRouter.use(configRouter);
apiRouter.use(confirmationRouter);
apiRouter.use(utilsRouter);
apiRouter.use(tokenRouter);
apiRouter.use(steerRouter);
apiRouter.use(syncRouter);
apiRouter.use(memoryRouter);
apiRouter.use(mcpRouter);
apiRouter.use(externalServiceRouter);
apiRouter.use(extensionsRouter);
