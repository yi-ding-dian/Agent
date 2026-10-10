/**
 * 全屏图片预览浮层工具
 *
 * 浮层 DOM 定义在 App.tsx（#imageOverlay / #overlayImg），点击遮罩关闭。
 * 用户上传的附件（MessageBubble）与 AI 回复正文里的图片（MarkdownRenderer）共用此入口。
 */

/** 打开全屏预览；浮层节点不存在或 src 为空时静默忽略 */
export function openImageOverlay(src: string): void {
  if (!src) return;
  const overlay = document.getElementById('imageOverlay');
  const overlayImg = document.getElementById('overlayImg') as HTMLImageElement | null;
  if (!overlay || !overlayImg) return;
  overlayImg.src = src;
  overlay.classList.add('active');
}
