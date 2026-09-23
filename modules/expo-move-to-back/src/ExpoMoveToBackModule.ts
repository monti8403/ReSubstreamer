import { requireNativeModule } from 'expo-modules-core';

interface ExpoMoveToBackInterface {
  moveToBack: () => void;
  setSkipPreviousBehavior?: (behavior: string) => void;
}

let module: ExpoMoveToBackInterface;

try {
  module = requireNativeModule('ExpoMoveToBack');
} catch {
  console.warn(
    '[expo-move-to-back] Native module not found. ' +
      'Run `npx expo run:ios` or `npx expo run:android` to rebuild with the native module.'
  );

  module = {
    moveToBack: () => {},
    setSkipPreviousBehavior: () => {},
  };
}

export default module;
