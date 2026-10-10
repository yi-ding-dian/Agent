import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initApiConfig } from './services/api-config';
import { getTheme, ensureHighlightTheme } from './services/theme';
import { migrateLegacyKeys } from './services/legacy-migration';
import './index.css';

// 应用启动时迁移旧 piagent_* localStorage key → myagent_*（幂等，不丢用户数据）
migrateLegacyKeys();

initApiConfig().then(async () => {
  // 按当前主题加载 hljs 高亮样式（React 渲染前完成，避免深色主题下代码高亮闪烁）
  await ensureHighlightTheme(getTheme());
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
