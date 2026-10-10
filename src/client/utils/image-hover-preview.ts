/**
 * 图片链接悬停预览浮层
 *
 * 悬停在「指向图片的链接」上片刻后，在鼠标右侧弹出缩略预览；移出链接 / 点击 / 滚动页面即收起。
 * 普通链接不受影响（判定见 isImageHref）。
 *
 * 单例 DOM 浮层（与 App.tsx 的 #imageOverlay 同思路）：
 *  - MarkdownRenderer 有多个实例（正文 / 思考过程 / 工具结果 / 详情弹窗），单例避免互相打架
 *  - 跟随鼠标需高频改位置，直接改样式比每帧触发 React 重渲染划算
 */
import { getLastMouse } from './mouse-position';

/** 图片扩展名（href 剥离 query/hash 后按 pathname 匹配） */
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico)$/i;

/** 悬停多久才弹预览（毫秒）：0.5s，兼顾防误触与跟手（1s 用户反馈太慢） */
const HOVER_DELAY_MS = 500;

/** 预览层与鼠标的间距（像素） */
const GAP = 16;

/** 与视口边缘的最小留白（像素） */
const EDGE = 8;

let showTimer: number | null = null;
let overlayEl: HTMLDivElement | null = null;
let imgEl: HTMLImageElement | null = null;
let statusEl: HTMLSpanElement | null = null;
let visible = false;
let globalBound = false;

/** 链接是否指向图片（相对路径按当前页面解析；非 http(s) 协议一律不认） */
export function isImageHref(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return IMAGE_EXT_RE.test(url.pathname);
  } catch {
    return false;
  }
}

/** 定位到鼠标右侧并垂直居中；右侧放不下翻到左侧，上下越界夹紧 */
function position(x: number, y: number): void {
  const el = overlayEl;
  if (!el) return;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = x + GAP;
  if (left + w > window.innerWidth - EDGE) left = x - GAP - w;
  if (left < EDGE) left = EDGE;
  let top = y - h / 2;
  top = Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/** 按当前鼠标位置重新定位（尺寸变化后调用） */
function reflow(): void {
  if (!visible) return;
  const m = getLastMouse();
  if (m) position(m.x, m.y);
}

/** 全局监听只挂一次：跟随移动、滚动 / 点击收起 */
function bindGlobalOnce(): void {
  if (globalBound) return;
  globalBound = true;
  window.addEventListener('mousemove', (e) => {
    if (!visible) return;
    position(e.clientX, e.clientY);
  });
  // capture: true 才能捕获内部滚动容器的滚动
  window.addEventListener('scroll', cancelImageHoverPreview, true);
  window.addEventListener('click', cancelImageHoverPreview, true);
}

function ensureOverlay(): HTMLDivElement {
  if (overlayEl) return overlayEl;

  const el = document.createElement('div');
  el.className = 'image-hover-preview';

  const img = document.createElement('img');
  img.alt = '';
  img.style.display = 'none';

  const status = document.createElement('span');
  status.className = 'image-hover-preview-status';

  el.append(img, status);
  document.body.appendChild(el);

  img.addEventListener('load', () => {
    status.style.display = 'none';
    img.style.display = 'block';
    reflow();
  });
  img.addEventListener('error', () => {
    img.style.display = 'none';
    status.textContent = '预览加载失败';
    status.style.display = 'block';
    reflow();
  });

  overlayEl = el;
  imgEl = img;
  statusEl = status;
  return el;
}

function show(src: string): void {
  const el = ensureOverlay();
  bindGlobalOnce();

  if (imgEl) {
    imgEl.style.display = 'none';
    imgEl.src = src;
  }
  if (statusEl) {
    statusEl.textContent = '加载中…';
    statusEl.style.display = 'block';
  }

  // 先显示（display 非 none 才能量到尺寸）再定位
  el.classList.add('active');
  visible = true;
  const m = getLastMouse();
  // 无真实鼠标坐标（键盘触发等）时退回视口中心
  position(m?.x ?? window.innerWidth / 2, m?.y ?? window.innerHeight / 2);
}

function hide(): void {
  if (!visible || !overlayEl) return;
  overlayEl.classList.remove('active');
  visible = false;
}

function cancelTimer(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
}

/** 悬停在图片链接上：启动延迟定时器（时长见 HOVER_DELAY_MS；重复调用会重置计时） */
export function scheduleImageHoverPreview(href: string): void {
  if (!isImageHref(href)) {
    cancelImageHoverPreview();
    return;
  }
  cancelTimer();
  showTimer = window.setTimeout(() => {
    showTimer = null;
    show(href);
  }, HOVER_DELAY_MS);
}

/** 取消待触发的预览，并收起已显示的浮层 */
export function cancelImageHoverPreview(): void {
  cancelTimer();
  hide();
}
