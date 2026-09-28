/**
 * Holds the initialization promise for the native player engine (RNQP).
 * Separated into a zero-dependency module to avoid circular dependencies
 * between playerBootstrap, headlessMediaService, and playerService.
 */

let resolvePlayerReady: () => void;
let isReady = false;

export const whenPlayerReady: Promise<void> = new Promise<void>((resolve) => {
  resolvePlayerReady = resolve;
  // In unit test runners, automatically resolve so tests that don't load playerBootstrap
  // don't stall waiting for native engine configure.
  if (process.env.NODE_ENV === 'test') {
    isReady = true;
    resolve();
  }
});

/** Mark that the native player engine has finished configure(). */
export function markPlayerReady(): void {
  isReady = true;
  resolvePlayerReady?.();
}

/** Check if player engine has completed configure(). */
export function isPlayerEngineConfigured(): boolean {
  return isReady;
}
