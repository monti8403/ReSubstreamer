import { Platform } from 'react-native';
import ExpoMoveToBackModule from './ExpoMoveToBackModule';

/**
 * Move the app to the background on Android.
 * No-op on iOS (no hardware back button).
 */
export function moveToBack(): void {
  ExpoMoveToBackModule.moveToBack();
}

/**
 * Persist the skip-previous behavior setting directly into Android SharedPreferences
 * so native MediaSession commands (headset/notification/Bluetooth) read it live without
 * tearing down or reconfiguring the audio engine.
 */
export function setNativeSkipPreviousBehavior(behavior: 'always-previous' | 'restart-or-previous'): void {
  if (Platform.OS === 'android') {
    try {
      ExpoMoveToBackModule.setSkipPreviousBehavior?.(behavior);
    } catch {
      // Ignore if called in environment where module is not available (e.g. tests)
    }
  }
}
