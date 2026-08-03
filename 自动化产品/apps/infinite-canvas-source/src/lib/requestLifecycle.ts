export interface CanvasLifecycleEventTarget {
  addEventListener(type: "pagehide" | "pageshow", listener: EventListener): void;
  removeEventListener(type: "pagehide" | "pageshow", listener: EventListener): void;
}

function abortReason(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

/**
 * Owns the caller signal for one mounted canvas project.
 *
 * A signal captured by an in-flight batch is never reused after page restore,
 * so an interrupted batch cannot silently resume and submit paid requests.
 */
export class CanvasRequestLifecycle {
  private controller = new AbortController();
  readonly projectId: string;

  constructor(projectId = "") {
    this.projectId = projectId;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  interrupt(message = "页面已离开，任务已中断"): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(abortReason(message));
    }
  }

  resume(): void {
    if (this.controller.signal.aborted) {
      this.controller = new AbortController();
    }
  }

  dispose(message = "画布已关闭或项目已切换，任务已中断"): void {
    this.interrupt(message);
  }
}

export function bindCanvasPageLifecycle(
  lifecycle: CanvasRequestLifecycle,
  target: CanvasLifecycleEventTarget,
): () => void {
  const onPageHide: EventListener = () => lifecycle.interrupt();
  const onPageShow: EventListener = () => lifecycle.resume();
  target.addEventListener("pagehide", onPageHide);
  target.addEventListener("pageshow", onPageShow);
  return () => {
    target.removeEventListener("pagehide", onPageHide);
    target.removeEventListener("pageshow", onPageShow);
  };
}
