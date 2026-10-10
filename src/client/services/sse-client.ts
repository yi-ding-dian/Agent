import type { SSEEvent } from '../types/events';
import { apiUrl } from './api-config';

/** 流中断错误：请求已到达、body 读流断开（区别于 fetch 阶段网络错误）——调用方不重发、走恢复视图 */
export class StreamInterruptedError extends Error {
  constructor() {
    super('连接中断');
    this.name = 'stream-interrupted';
  }
}

export async function fetchSSE(
  path: string,
  body: Record<string, unknown>,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = localStorage.getItem('myagent_token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // fetch 阶段网络错误（请求未建立/未送达）→ 指数退避重试，最多 3 次；
  // 一旦建立连接（拿到 HTTP 响应）后发生断流则绝不重发——否则服务端会收到重复消息。
  const RETRY_DELAYS = [1000, 2000, 4000];
  let response: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      response = await fetch(apiUrl(path), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      break;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
      if (attempt < RETRY_DELAYS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }
  if (!response) throw lastErr ?? new Error('网络连接失败');

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEventType = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            // 根据外层 event 类型区分
            if (currentEventType === 'done') {
              onEvent({ type: 'done' });
            } else {
              onEvent(data as SSEEvent);
            }
          } catch {
            // skip invalid json
          }
          currentEventType = '';
        }
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    throw new StreamInterruptedError();
  }
}
