/**
 * 账户域（设置 → 账户）
 *
 * 展示当前登录用户信息 + 头像更换（存 localStorage）+ 退出登录。
 * 无保存栏 —— 头像即时生效，用户信息只读。
 */
import { useState } from 'react';
import { useAuthStore } from '../../../store/auth-store';
import { toast } from '../../../store/toast-store';

export function UserPanel() {
  const user = useAuthStore((s) => s.user);
  const [avatar, setAvatar] = useState<string>(() => localStorage.getItem('myagent_avatar') || '');

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error('头像图片不能超过 2MB'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setAvatar(dataUrl);
      localStorage.setItem('myagent_avatar', dataUrl);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="user-settings">
      <div className="user-profile-card">
        <div className="user-avatar-section">
          <div className="user-avatar" onClick={() => document.getElementById('avatar-input')?.click()}>
            {avatar ? (
              <img src={avatar} alt="头像" className="user-avatar-img" />
            ) : (
              <span className="user-avatar-letter">{user?.username?.[0]?.toUpperCase() || '?'}</span>
            )}
            <div className="user-avatar-overlay">点击更换</div>
          </div>
          <input
            id="avatar-input"
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleAvatarChange}
          />
        </div>
        <div className="user-info-section">
          <div className="user-info-row">
            <span className="user-info-label">用户名</span>
            <span className="user-info-value">{user?.username || '-'}</span>
          </div>
          <div className="user-info-row">
            <span className="user-info-label">账号</span>
            <span className="user-info-value">{user?.account || '-'}</span>
          </div>
          {user?.last_login_at && (
            <div className="user-info-row">
              <span className="user-info-label">上次登录</span>
              <span className="user-info-value">{user.last_login_at}</span>
            </div>
          )}
        </div>
        <button className="btn btn-danger user-logout-btn" onClick={() => useAuthStore.getState().logout()}>
          退出登录
        </button>
      </div>
    </div>
  );
}
