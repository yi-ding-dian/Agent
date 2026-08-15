import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../../store/auth-store';
import { getApiConfig, setApiConfig } from '../../services/api-config';

export function LoginPage() {
  const login = useAuthStore((s) => s.login);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  const defaultConfig = getApiConfig();
  const [apiHost, setApiHost] = useState(defaultConfig.host);
  const [apiPort, setApiPort] = useState(defaultConfig.port);
  const [saveMsg, setSaveMsg] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!account.trim() || !password.trim()) {
      setError('请输入账号和密码');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await login(account.trim(), password);
    } catch (err: any) {
      setError(err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = () => {
    if (!apiHost.trim() || !apiPort.trim()) {
      setSaveMsg('IP 和端口不能为空');
      return;
    }
    setApiConfig({ host: apiHost.trim(), port: apiPort.trim() });
    // Electron 模式：写回主进程 server-url.json，重启后地址保持一致
    if (window.myagent) {
      const url = `http://${apiHost.trim()}:${apiPort.trim()}`;
      window.myagent.setServerUrl(url).catch(() => {});
    }
    setSaveMsg('配置已保存');
    setTimeout(() => {
      setSaveMsg('');
      setShowSettingsModal(false);
    }, 800);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">MyAgent</h1>
        <p className="login-subtitle">AI 智能对话平台</p>
        <form onSubmit={handleSubmit}>
          {error && <div className="login-error">{error}</div>}
          <div className="login-field">
            <label>账号</label>
            <input
              type="text"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="请输入账号"
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className="login-field">
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
            />
          </div>
          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? '登录中...' : '登 录'}
          </button>
        </form>

        <div className="login-settings-toggle">
          <button
            className="login-settings-link"
            onClick={() => {
              setSaveMsg('');
              setShowSettingsModal(true);
            }}
          >
            服务器设置
          </button>
        </div>
      </div>

      {showSettingsModal && (
        <div className="login-modal-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="login-modal" onClick={(e) => e.stopPropagation()}>
            <div className="login-modal-header">
              <h3>服务器设置</h3>
              <button
                className="login-modal-close"
                onClick={() => setShowSettingsModal(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="login-field">
              <label>服务器 IP</label>
              <input
                type="text"
                value={apiHost}
                onChange={(e) => setApiHost(e.target.value)}
                placeholder="例如: localhost 或 <服务器地址>"
              />
            </div>
            <div className="login-field">
              <label>服务器端口</label>
              <input
                type="text"
                value={apiPort}
                onChange={(e) => setApiPort(e.target.value)}
                placeholder="例如: 7980"
              />
            </div>
            {saveMsg && (
              <div className="login-settings-msg success">{saveMsg}</div>
            )}
            <div className="login-modal-actions">
              <button className="login-btn" type="button" onClick={handleSaveSettings}>
                保存配置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
