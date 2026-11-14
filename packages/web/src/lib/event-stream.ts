import type { BackendClient } from './backend-client';

/** Same-origin streams carry the page capability; external feeds use native SSE. */
export function eventStream(value: string, client: BackendClient) {
  const url = new URL(value, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
    const external = new EventSource(value);
    client.signal.addEventListener('abort', () => external.close(), { once: true });
    return external;
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, client.signal]);
  let lastEventId = "";
  const listeners: Record<string, Array<(event: MessageEvent) => void>> = {};
  const source = {
    onopen: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      (listeners[type] ??= []).push(listener);
    },
    close() { controller.abort(); },
  };
  async function connect() {
    while (!signal.aborted) {
      try {
        const response = await client.request(`${url.pathname}${url.search}`, { signal, headers: { Accept: 'text/event-stream', ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) } });
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Stream unavailable');
        source.onopen?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (!signal.aborted) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
            if (buffer.length > 2_000_000) throw new Error('Stream event exceeds limit');
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              let type = 'message'; const data: string[] = [];
              for (const line of frame.split('\n')) {
                if (line.startsWith('id:')) { const id = line.slice(3).replace(/^ /, ''); if (!id.includes('\0') && id.length <= 512) lastEventId = id; }
                if (line.startsWith('event:')) type = line.slice(6).trim();
                if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
              }
              if (data.length) {
                const event = new MessageEvent(type, { data: data.join('\n'), lastEventId });
                if (type === 'message') source.onmessage?.(event);
                for (const listener of listeners[type] ?? []) listener(event);
              }
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch { if (signal.aborted) return; }
      if (signal.aborted) return;
      source.onerror?.();
      const pause = Promise.withResolvers<void>();
      const timer = setTimeout(pause.resolve, 3000);
      const cancel = () => { clearTimeout(timer); pause.resolve(); };
      signal.addEventListener('abort', cancel, { once: true });
      await pause.promise;
      signal.removeEventListener('abort', cancel);
    }
  }
  void connect();
  return source;
}
