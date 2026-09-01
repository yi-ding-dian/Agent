/**
 * 跟踪最近鼠标坐标（模块加载即挂监听，页面一打开即生效）
 *
 * toast / 确认弹窗等跟随鼠标出现的浮层共用：弹出时取当前鼠标位置；
 * 无任何真实坐标（键盘触发、坐标 (0,0) 的 click）返回 null，调用方兜底。
 */
let lastMouse: { x: number; y: number } | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('mousemove', (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('click', (e) => {
    // 键盘触发的 click 坐标为 (0,0)，不更新
    if (e.clientX !== 0 || e.clientY !== 0) lastMouse = { x: e.clientX, y: e.clientY };
  });
}

export function getLastMouse(): { x: number; y: number } | null {
  return lastMouse;
}
