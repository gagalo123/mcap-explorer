import type { SummaryDto } from "../shared/dto";
import type {
  ErrorDto,
  HostToWebview,
  RequestOp,
  ResponseBody,
  WebviewToHost,
} from "../shared/protocol";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export interface InitMessage {
  summary?: SummaryDto;
  error?: ErrorDto;
}

export class RpcError extends Error {
  constructor(readonly dto: ErrorDto) {
    super(dto.message);
    this.name = "RpcError";
  }
}

interface RequestOptions {
  onProgress?: (loadedBytes: number, totalBytes?: number) => void;
  signal?: AbortSignal;
}

interface Pending {
  resolve: (body: ResponseBody) => void;
  reject: (err: RpcError) => void;
  onProgress?: (loadedBytes: number, totalBytes?: number) => void;
}

export class RpcClient {
  #api = acquireVsCodeApi();
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #onInit: ((msg: InitMessage) => void) | undefined;

  constructor() {
    window.addEventListener("message", (event: MessageEvent) => {
      this.#onMessage(event.data as HostToWebview);
    });
  }

  onInit(handler: (msg: InitMessage) => void): void {
    this.#onInit = handler;
  }

  /** Signals the host that the webview is mounted; host replies with `init`. */
  ready(): void {
    this.#post({ kind: "ready" });
  }

  request(op: RequestOp, options: RequestOptions = {}): Promise<ResponseBody> {
    const id = this.#nextId++;
    return new Promise<ResponseBody>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onProgress: options.onProgress });
      options.signal?.addEventListener("abort", () => this.#post({ kind: "cancel", id }), {
        once: true,
      });
      this.#post({ kind: "request", id, op });
    });
  }

  getState<T>(): T | undefined {
    return this.#api.getState() as T | undefined;
  }

  setState(state: unknown): void {
    this.#api.setState(state);
  }

  #post(msg: WebviewToHost): void {
    this.#api.postMessage(msg);
  }

  #onMessage(msg: HostToWebview): void {
    switch (msg.kind) {
      case "init":
        this.#onInit?.({ summary: msg.summary, error: msg.error });
        return;
      case "response": {
        const pending = this.#pending.get(msg.id);
        if (!pending) {
          return;
        }
        this.#pending.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.body);
        } else {
          pending.reject(new RpcError(msg.error));
        }
        return;
      }
      case "progress":
        this.#pending.get(msg.id)?.onProgress?.(msg.loadedBytes, msg.totalBytes);
        return;
      case "batch":
        // Streamed results arrive in Phase 2 (message browsing).
        return;
    }
  }
}
