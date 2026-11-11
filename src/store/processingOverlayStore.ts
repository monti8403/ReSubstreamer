import { create } from 'zustand';

export type OverlayStatus = 'idle' | 'processing' | 'success' | 'error';

const AUTO_DISMISS_ERROR_MS = 3000;

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

export interface ProcessingOverlayState {
  status: OverlayStatus;
  label: string;
  /** Timestamp when `showError()` was called. */
  _showedAt: number;

  show: (label: string) => void;
  showSuccess: (label: string) => void;
  showError: (label: string) => void;
  hide: () => void;
}

export const processingOverlayStore = create<ProcessingOverlayState>()((set, get) => ({
  status: 'idle',
  label: '',
  _showedAt: 0,

  // Fullscreen loading overlay has been completely removed across the app.
  // Method retained for backward compatibility with existing callers as a no-op.
  show: (_label) => {
    // No-op: blocking UI loaders are permanently disabled
  },

  // Fullscreen/popup success overlays have been completely removed.
  // UI operations succeed optimistically without interrupting touches.
  showSuccess: (_label) => {
    // No-op
  },

  // Non-blocking error toast: auto-dismisses after 3 seconds.
  showError: (label) => {
    clearTimers();
    set({ status: 'error', label, _showedAt: Date.now() });
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      if (get().status === 'error') {
        get().hide();
      }
    }, AUTO_DISMISS_ERROR_MS);
  },

  hide: () => {
    clearTimers();
    set({ status: 'idle', label: '' });
  },
}));

/**
 * Run an async task without blocking the UI.
 * On rejection, triggers the non-blocking error toast.
 */
export async function runWithOverlay<T>(
  task: () => Promise<T>,
  messages: { loading?: string; success?: string; error: string },
): Promise<T | undefined> {
  try {
    const result = await task();
    return result;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[processingOverlay] task failed:', e);
    processingOverlayStore.getState().showError(messages.error);
    return undefined;
  }
}
