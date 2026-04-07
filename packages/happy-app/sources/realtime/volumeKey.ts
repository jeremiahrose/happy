import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const VolumeKey = Platform.OS === 'android' ? NativeModules.VolumeKey : null;
const emitter = VolumeKey ? new NativeEventEmitter(VolumeKey) : null;

console.log('[VolumeKey] Native module available:', !!VolumeKey);

export interface VolumeKeyEvent {
    direction: 'up' | 'down';
    timestamp: number;
}

export async function isVolumeKeyAccessibilityEnabled(): Promise<boolean> {
    if (!VolumeKey) return false;
    try {
        return await VolumeKey.isAccessibilityEnabled();
    } catch {
        return false;
    }
}

export async function openVolumeKeyAccessibilitySettings(): Promise<void> {
    if (!VolumeKey) return;
    await VolumeKey.openAccessibilitySettings();
}

export async function startVolumeKeyListening(): Promise<void> {
    if (!VolumeKey) {
        console.warn('[VolumeKey] Cannot start listening - native module not available');
        return;
    }
    console.log('[VolumeKey] Starting listening...');
    await VolumeKey.startListening();
    console.log('[VolumeKey] Listening started');
}

export async function stopVolumeKeyListening(): Promise<void> {
    if (!VolumeKey) return;
    await VolumeKey.stopListening();
}

export function addVolumeKeyDownListener(callback: (event: VolumeKeyEvent) => void): () => void {
    if (!emitter) return () => {};
    const subscription = emitter.addListener('volumeKeyDown', (event) => {
        console.log('[VolumeKey] Down:', event);
        callback(event);
    });
    return () => subscription.remove();
}

export function addVolumeKeyUpListener(callback: (event: VolumeKeyEvent) => void): () => void {
    if (!emitter) return () => {};
    const subscription = emitter.addListener('volumeKeyUp', (event) => {
        console.log('[VolumeKey] Up:', event);
        callback(event);
    });
    return () => subscription.remove();
}
