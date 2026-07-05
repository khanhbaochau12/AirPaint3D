import { StrokeData, StrokeEngine } from '../render/StrokeEngine';

type SyncMessage =
  | { type: 'stroke_add';    data: StrokeData }
  | { type: 'stroke_undo';   id: string }
  | { type: 'stroke_clear' }
  | { type: 'cursor_move';   userId: string; x: number; y: number; z: number }
  | { type: 'user_join';     userId: string; color: string }
  | { type: 'user_leave';    userId: string }
  | { type: 'sync_full';     strokes: StrokeData[] };

/**
 * MultiplayerSync
 * Đồng bộ stroke giữa các client qua WebSocket.
 *
 * Protocol:
 *   Client → Server → Broadcast → All other clients
 *
 * Optimizations:
 * - Chỉ gửi khi stroke commit (không gửi mỗi điểm)
 * - Gzip compression (server-side)
 * - userId deduplicate (tránh apply chính stroke của mình)
 */
export type SyncStatus = 'connecting' | 'connected' | 'disconnected';

export interface MultiplayerOptions {
  onStatusChange?: (status: SyncStatus) => void;
  /** Gọi khi nhận vị trí cursor của user khác — để render indicator. */
  onRemoteCursor?: (userId: string, x: number, y: number, z: number) => void;
  onUserLeave?:    (userId: string) => void;
}

export class MultiplayerSync {
  private ws!: WebSocket;
  private engine: StrokeEngine;
  private userId: string;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private disposed = false;
  private opts: MultiplayerOptions;

  constructor(
    private url: string,
    engine: StrokeEngine,
    opts: MultiplayerOptions = {}
  ) {
    this.engine = engine;
    this.userId = this.generateUserId();
    this.opts   = opts;
    this.connect();
  }

  // ────────────────────────────────────────────────────────
  // CONNECTION
  // ────────────────────────────────────────────────────────

  private connect(): void {
    if (this.disposed) return;
    this.opts.onStatusChange?.('connecting');
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[MP] Connected to', this.url);
      this.opts.onStatusChange?.('connected');
      this.reconnectDelay = 1000;

      // Identify ourselves
      this.send({ type: 'user_join', userId: this.userId, color: '#63b3ed' });
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = () => {
      this.opts.onStatusChange?.('disconnected');
      if (this.disposed) return;
      // Exponential backoff reconnect
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    };

    this.ws.onerror = (err) => {
      console.error('[MP] WebSocket error:', err);
    };
  }

  // ────────────────────────────────────────────────────────
  // INCOMING
  // ────────────────────────────────────────────────────────

  private handleMessage(raw: string | ArrayBuffer): void {
    let msg: SyncMessage;
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      msg = JSON.parse(text);
    } catch (e) {
      console.warn('[MP] Invalid message:', e);
      return;
    }

    switch (msg.type) {
      case 'stroke_add':
        // Ai đó vừa vẽ xong một stroke — hydrate vào scene local
        this.engine.hydrateStroke(msg.data);
        break;

      case 'stroke_undo':
        this.engine.removeById(msg.id);
        break;

      case 'stroke_clear':
        this.engine.clear();
        break;

      case 'sync_full':
        // Server gửi toàn bộ state khi user join muộn
        this.engine.clear();
        msg.strokes.forEach(s => this.engine.hydrateStroke(s));
        break;

      case 'cursor_move':
        if (msg.userId !== this.userId) {
          this.opts.onRemoteCursor?.(msg.userId, msg.x, msg.y, msg.z);
        }
        break;

      case 'user_leave':
        this.opts.onUserLeave?.(msg.userId);
        break;
    }
  }

  // ────────────────────────────────────────────────────────
  // OUTGOING
  // ────────────────────────────────────────────────────────

  /** Gọi sau strokeEngine.commitStroke() để broadcast cho người khác. */
  broadcastStroke(data: StrokeData): void {
    this.send({ type: 'stroke_add', data });
  }

  broadcastUndo(id: string): void {
    this.send({ type: 'stroke_undo', id });
  }

  broadcastClear(): void {
    this.send({ type: 'stroke_clear' });
  }

  /** Broadcast vị trí cursor (throttle ở nơi gọi ~30fps). */
  broadcastCursor(x: number, y: number, z: number): void {
    this.send({ type: 'cursor_move', userId: this.userId, x, y, z });
  }

  private send(msg: SyncMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  // ────────────────────────────────────────────────────────
  // UTILS
  // ────────────────────────────────────────────────────────

  private generateUserId(): string {
    return `user_${Math.random().toString(36).slice(2, 9)}`;
  }

  disconnect(): void {
    this.disposed = true;
    this.ws.close();
  }
}
