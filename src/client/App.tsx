import { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { LoginPage } from './components/auth/LoginPage';
import { ToastHost } from './components/common/ToastHost';
import { ConfirmDialogHost } from './components/common/ConfirmDialogHost';
import { ResizableModal } from './components/common/ResizableModal';
import { useChatStore } from './store/chat-store';
import { useAuthStore } from './store/auth-store';
import { usePreviewStore } from './store/preview-store';
import { getWSClient } from './services/ws-client';
import { isElectron } from './services/api-config';

export default function App() {
  const token = useAuthStore((s) => s.token);
  const isChecking = useAuthStore((s) => s.isChecking);
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadConfig = useChatStore((s) => s.loadConfig);
  const previewOpen = usePreviewStore((s) => s.open);
  const setPreviewOpen = usePreviewStore((s) => s.setOpen);

  // Markdown 渲染的内联「预览」按钮（非 React 代码）经窗口事件触发
  useEffect(() => {
    const h = () => setPreviewOpen(true);
    window.addEventListener('myagent:preview-open', h);
    return () => window.removeEventListener('myagent:preview-open', h);
  }, [setPreviewOpen]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // 事件通道管理：Electron 模式走 IPC（主进程引擎事件），网页模式走 WebSocket
  useEffect(() => {
    if (token) {
      // Electron 模式：订阅主进程 agent:event 推送（handleSSEEvent 原样复用）
      if (isElectron()) {
        const off = window.myagent!.onAgentEvent((ev) => {
          useChatStore.getState().handleSSEEvent(ev as any);
        });
        // 引擎状态推送
        const offStatus = window.myagent!.onEngineStatus((status) => {
          useChatStore.setState({ engineStatus: status as any });
        });
        window.myagent!.getEngineStatus().then((status) => {
          useChatStore.setState({ engineStatus: status as any });
        }).catch(() => {});
        return () => {
          off();
          offStatus();
        };
      }

      const ws = getWSClient();
      ws.connect(token);

      // WS 状态变化同步到 store
      const unsubStatus = ws.onStatusChange((status) => {
        useChatStore.setState({ wsStatus: status });
      });

      // WS 事件处理
      const unsubEvent = ws.onEvent((msg) => {
        if (msg.type !== 'auth_ok' && msg.type !== 'ping' && msg.type !== 'pong') {
          useChatStore.getState().handleWSEvent(msg as any);
        }
      });

      return () => {
        unsubStatus();
        unsubEvent();
        ws.disconnect();
      };
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      loadSessions();
      loadConfig();
    }
  }, [token, loadSessions, loadConfig]);

  // 正在检查登录状态
  if (isChecking) {
    return (
      <>
        <ToastHost />
        <ConfirmDialogHost />
        <div className="login-page">
          <div className="login-card">
            <p style={{ textAlign: 'center', color: '#999' }}>加载中...</p>
          </div>
        </div>
      </>
    );
  }

  // 未登录 → 登录页
  if (!token) {
    return (
      <>
        <ToastHost />
        <ConfirmDialogHost />
        <LoginPage />
      </>
    );
  }

  // 已登录 → 聊天界面
  return (
    <>
      <ToastHost />
      <ConfirmDialogHost />
      <AppLayout />
      {/* HTML 预览浮层（ResizableModal：Esc/mask 点击关闭 + 可拖大小；iframe id 供预览代码动态注入） */}
      {previewOpen && (
        <div className="modal-overlay" onClick={() => setPreviewOpen(false)}>
          <ResizableModal width={900} height="80vh" onEsc={() => setPreviewOpen(false)}>
            <div className="preview-overlay-header">
              <span>HTML 预览</span>
              <button className="modal-close-btn" onClick={() => setPreviewOpen(false)}>&#10005;</button>
            </div>
            <div className="preview-overlay-body" style={{ flex: 1, minHeight: 0 }}>
              <iframe id="previewIframe" sandbox="allow-scripts" style={{ width: '100%', height: '100%', border: 0 }} />
            </div>
          </ResizableModal>
        </div>
      )}
      {/* 图片放大遮罩 */}
      <div
        id="imageOverlay"
        className="image-overlay"
        onClick={(e) => {
          (e.currentTarget as HTMLElement).classList.remove('active');
        }}
      >
        <img id="overlayImg" alt="放大图片" onClick={(e) => e.stopPropagation()} />
      </div>
    </>
  );
}
