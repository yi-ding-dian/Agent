import type { Response } from 'express';

export interface SSEEvent {
  type: string;
  thinking?: boolean;
  [key: string]: unknown;
}

export function setupSSEHeaders(res: Response): void {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

export function sendSSEEvent(res: Response, eventType: string, data: SSEEvent): void {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sendSSEComment(res: Response, comment = ''): void {
  res.write(`: ${comment}\n\n`);
}
