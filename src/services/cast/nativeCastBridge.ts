import * as ReactNative from 'react-native';
import { Cast } from 'react-native-queue-player';

export interface SsdpDeviceEvent {
  location: string;
  usn: string;
  st: string;
  server: string;
}

export interface SsdpScanFinishedEvent {
  reason: string;
  packetsReceived?: number;
  locationsCount?: number;
}

export type SystemRouteKind =
  | 'speaker'
  | 'bluetooth'
  | 'wired'
  | 'usb'
  | 'hdmi'
  | 'unknown';

export interface SystemAudioRoute {
  id: string;
  name: string;
  kind: SystemRouteKind;
  isSelected: boolean;
}

export interface SystemAudioState {
  volumePercent: number;
  routes: SystemAudioRoute[];
}

interface AtrumCastNativeModule {
  startSsdpDiscovery: (timeoutMs: number) => Promise<void>;
  stopSsdpDiscovery: () => Promise<void>;
  openSystemOutputSwitcher: () => Promise<string>;
  getSystemAudioState?: () => Promise<SystemAudioState>;
  selectSystemAudioRoute?: (routeId: string) => Promise<boolean>;
  setSystemMediaVolume?: (volumePercent: number) => Promise<number>;
}

const EVENT_DEVICE_FOUND = 'AtrumSsdpDeviceFound';
const EVENT_SCAN_FINISHED = 'AtrumSsdpScanFinished';
const EVENT_SYSTEM_ROUTES_CHANGED = 'AtrumSystemRoutesChanged';

let cachedEmitter: ReactNative.NativeEventEmitter | null = null;

function getNativeModule(): AtrumCastNativeModule | null {
  if (ReactNative.Platform.OS !== 'android') return null;
  const mod = ReactNative.NativeModules?.AtrumCastModule as AtrumCastNativeModule | undefined;
  return mod ?? null;
}

function getEmitter(): ReactNative.NativeEventEmitter | null {
  const mod = getNativeModule();
  if (!mod) return null;
  const EmitterCtor = ReactNative.NativeEventEmitter;
  if (typeof EmitterCtor !== 'function') return null;
  if (!cachedEmitter) {
    cachedEmitter = new EmitterCtor(mod as unknown as ReactNative.NativeModule);
  }
  return cachedEmitter;
}

export function isNativeSsdpAvailable(): boolean {
  return getNativeModule() !== null;
}

export async function startNativeSsdpDiscovery(timeoutMs = 6000): Promise<void> {
  const mod = getNativeModule();
  if (!mod) return;
  await mod.startSsdpDiscovery(timeoutMs);
}

export async function stopNativeSsdpDiscovery(): Promise<void> {
  const mod = getNativeModule();
  if (!mod) return;
  await mod.stopSsdpDiscovery();
}

export async function openSystemOutputSwitcher(): Promise<string> {
  if (ReactNative.Platform.OS === 'ios') {
    await Cast.showSystemPicker();
    return 'ios_system_picker';
  }
  const mod = getNativeModule();
  if (!mod) {
    throw new Error('AtrumCastModule is unavailable');
  }
  return mod.openSystemOutputSwitcher();
}

export async function getSystemAudioState(): Promise<SystemAudioState | null> {
  const mod = getNativeModule();
  if (!mod?.getSystemAudioState) return null;
  try {
    return await mod.getSystemAudioState();
  } catch {
    return null;
  }
}

export async function selectSystemAudioRoute(routeId: string): Promise<boolean> {
  const mod = getNativeModule();
  if (!mod?.selectSystemAudioRoute) return false;
  try {
    return await mod.selectSystemAudioRoute(routeId);
  } catch {
    return false;
  }
}

export async function setSystemMediaVolume(volumePercent: number): Promise<number | null> {
  const mod = getNativeModule();
  if (!mod?.setSystemMediaVolume) return null;
  try {
    return await mod.setSystemMediaVolume(volumePercent);
  } catch {
    return null;
  }
}

export function subscribeSsdpDeviceFound(
  listener: (event: SsdpDeviceEvent) => void,
): () => void {
  const emitter = getEmitter();
  if (!emitter) return () => {};
  const sub = emitter.addListener(EVENT_DEVICE_FOUND, listener);
  return () => sub.remove();
}

export function subscribeSsdpScanFinished(
  listener: (event: SsdpScanFinishedEvent) => void,
): () => void {
  const emitter = getEmitter();
  if (!emitter) return () => {};
  const sub = emitter.addListener(EVENT_SCAN_FINISHED, listener);
  return () => sub.remove();
}

export function subscribeSystemRoutesChanged(listener: () => void): () => void {
  const emitter = getEmitter();
  if (!emitter) return () => {};
  const sub = emitter.addListener(EVENT_SYSTEM_ROUTES_CHANGED, listener);
  return () => sub.remove();
}
