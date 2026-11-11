import { processingOverlayStore, runWithOverlay } from '../processingOverlayStore';

beforeEach(() => {
  jest.useFakeTimers();
  processingOverlayStore.setState({ status: 'idle', label: '', _showedAt: 0 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('processingOverlayStore', () => {
  it('show is a no-op so fullscreen loaders never appear', () => {
    processingOverlayStore.getState().show('Working...');
    expect(processingOverlayStore.getState().status).toBe('idle');
    expect(processingOverlayStore.getState().label).toBe('');
  });

  it('showSuccess is a no-op so success popups never appear', () => {
    processingOverlayStore.getState().showSuccess('Done');
    expect(processingOverlayStore.getState().status).toBe('idle');
    expect(processingOverlayStore.getState().label).toBe('');
  });

  it('showError sets error status and label', () => {
    processingOverlayStore.getState().showError('Failed');
    expect(processingOverlayStore.getState().status).toBe('error');
    expect(processingOverlayStore.getState().label).toBe('Failed');
  });

  it('showError auto-dismisses after 3000ms', () => {
    processingOverlayStore.getState().showError('Network error');
    expect(processingOverlayStore.getState().status).toBe('error');

    jest.advanceTimersByTime(2999);
    expect(processingOverlayStore.getState().status).toBe('error');

    jest.advanceTimersByTime(1);
    expect(processingOverlayStore.getState().status).toBe('idle');
    expect(processingOverlayStore.getState().label).toBe('');
  });

  it('hide resets to idle and clears label immediately', () => {
    processingOverlayStore.getState().showError('Oops');
    expect(processingOverlayStore.getState().status).toBe('error');

    processingOverlayStore.getState().hide();
    expect(processingOverlayStore.getState().status).toBe('idle');
    expect(processingOverlayStore.getState().label).toBe('');
  });

  it('subsequent showError resets the 3-second auto-dismiss timer', () => {
    processingOverlayStore.getState().showError('First error');
    jest.advanceTimersByTime(2000);
    expect(processingOverlayStore.getState().status).toBe('error');

    processingOverlayStore.getState().showError('Second error');
    expect(processingOverlayStore.getState().label).toBe('Second error');

    // 2000ms after second error: should still be showing
    jest.advanceTimersByTime(2000);
    expect(processingOverlayStore.getState().status).toBe('error');
    expect(processingOverlayStore.getState().label).toBe('Second error');

    // 1000ms later (total 3000ms after second error): dismissed
    jest.advanceTimersByTime(1000);
    expect(processingOverlayStore.getState().status).toBe('idle');
  });

  describe('runWithOverlay', () => {
    it('runs task without blocking UI and returns result', async () => {
      const task = jest.fn().mockResolvedValue('success-data');
      const result = await runWithOverlay(task, {
        loading: 'Loading...',
        success: 'Done',
        error: 'Failed',
      });

      expect(task).toHaveBeenCalled();
      expect(result).toBe('success-data');
      expect(processingOverlayStore.getState().status).toBe('idle');
    });

    it('catches task error and triggers non-blocking showError toast', async () => {
      const task = jest.fn().mockRejectedValue(new Error('boom'));
      const result = await runWithOverlay(task, {
        loading: 'Loading...',
        success: 'Done',
        error: 'Failed to process',
      });

      expect(result).toBeUndefined();
      expect(processingOverlayStore.getState().status).toBe('error');
      expect(processingOverlayStore.getState().label).toBe('Failed to process');
    });
  });
});
