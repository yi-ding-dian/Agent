import { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { LoginPage } from './components/auth/LoginPage';
import { useChatStore } from './store/chat-store';
import { useAuthStore } from './store/auth-store';
import { getWSClient } from './services/ws-client';
import { isElectron } from './services/api-config';

export default function App() {
  const token = useAuthStore((s) => s.token);
  const isChecking = useAuthStore((s) => s.isChecking);
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadConfig = useChatStore((s) => s.loadConfig);

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
      <div className="login-page">
        <div className="login-card">
          <p style={{ textAlign: 'center', color: '#999' }}>加载中...</p>
        </div>
      </div>
    );
  }

  // 未登录 → 登录页
  if (!token) {
    return <LoginPage />;
  }

  // 已登录 → 聊天界面
  return (
    <>
      <AppLayout />
      <div
        id="previewOverlay"
        className="preview-overlay"
        onClick={() => document.getElementById('previewOverlay')?.classList.remove('active')}
      >
        <div className="preview-overlay-box" onClick={(e) => e.stopPropagation()}>
          <div className="preview-overlay-header">
            <span>HTML 预览</span>
            <button
              className="modal-close-btn"
              onClick={() => document.getElementById('previewOverlay')?.classList.remove('active')}
            >
              &#10005;
            </button>
          </div>
          <div className="preview-overlay-body">
            <iframe id="previewIframe" sandbox="allow-scripts" />
          </div>
        </div>
      </div>
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
