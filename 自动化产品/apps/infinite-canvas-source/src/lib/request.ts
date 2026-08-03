export type CanvasRequestErrorCode =
  | "cancelled"
  | "timeout"
  | "payload-too-large"
  | "http";

export class CanvasRequestError extends Error {
  readonly code: CanvasRequestErrorCode;
  readonly status: number;

  constructor(
    message: string,
    code: CanvasRequestErrorCode,
    status = 0,
  ) {
    super(message);
    this.name = "CanvasRequestError";
    this.code = code;
    this.status = status;
  }
}

export interface AbortableRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  label?: string;
}

export function canvasHttpError(
  status: number,
  detail = "",
  label = "请求",
): CanvasRequestError {
  const clean = detail.trim();
  if (status === 413) {
    return new CanvasRequestError(
      clean || `${label}内容过大，请减少图片数量或压缩后重试`,
      "payload-too-large",
      status,
    );
  }
  if (status === 499) {
    return new CanvasRequestError(`${label}已取消`, "cancelled", status);
  }
  return new CanvasRequestError(
    clean || `${label}失败 (${status})`,
    "http",
    status,
  );
}

/** Compose caller cancellation with a bounded request lifetime. */
export async function runAbortableRequest<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: AbortableRequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const label = options.label || "请求";
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("timeout", "TimeoutError"));
      }, Number(options.timeoutMs))
    : null;
  try {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new DOMException("cancelled", "AbortError");
    }
    return await run(controller.signal);
  } catch (error) {
    if (error instanceof CanvasRequestError) throw error;
    if (timedOut) {
      throw new CanvasRequestError(`${label}超时，可重试`, "timeout");
    }
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new CanvasRequestError(`${label}已取消`, "cancelled", 499);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function isCanvasRequestCancelled(error: unknown): boolean {
  if (error instanceof CanvasRequestError) return error.code === "cancelled";
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfCanvasRequestAborted(
  signal: AbortSignal,
  label = "任务",
): void {
  if (signal.aborted) {
    throw new CanvasRequestError(`${label}已取消`, "cancelled", 499);
  }
}

export function canvasRequestUserMessage(error: unknown): string {
  if (error instanceof CanvasRequestError) return error.message;
  return error instanceof Error && error.message.trim()
    ? error.message
    : "生成失败，请重试";
}
