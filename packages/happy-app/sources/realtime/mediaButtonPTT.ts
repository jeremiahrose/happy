import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { startTalking, stopTalking } from './RealtimeSession';

// Media button toggle PTT.
//
// Pressing the headphone media button (e.g. play/pause) toggles PTT:
// - First press: start talking
// - Second press: stop talking
//
// Works with screen off via MediaSession in the foreground service.

let listening = false;
let isTalking = false;
let subscription: { remove: () => void } | null = null;

type TalkingStateListener = (talking: boolean) => void;
const stateListeners = new Set<TalkingStateListener>();

function notifyListeners() {
    for (const listener of stateListeners) {
        listener(isTalking);
    }
}

export function addMediaButtonPTTListener(listener: TalkingStateListener): () => void {
    stateListeners.add(listener);
    return () => { stateListeners.delete(listener); };
}

function handleMediaButtonEvent(event: { keyCode: number; keyCodeName: string; action: string; repeatCount: number }) {
    // Only act on DOWN to avoid double-firing
    if (event.action !== 'DOWN') return;

    console.log(`[PTT] Media button: ${event.keyCodeName} ${event.action}`);

    if (!isTalking) {
        isTalking = true;
        startTalking();
        notifyListeners();
        console.log('[PTT] Started talking');
    } else {
        isTalking = false;
        stopTalking();
        notifyListeners();
        console.log('[PTT] Stopped talking');
    }
}

export function startMediaButtonPTT(): void {
    if (listening) return;
    if (Platform.OS !== 'android') return;

    const emitter = new NativeEventEmitter(NativeModules.VoiceForegroundService);
    subscription = emitter.addListener('mediaButtonEvent', handleMediaButtonEvent);
    listening = true;
    isTalking = false;
    notifyListeners();
    console.log('[PTT] Media button PTT started');
}

export function stopMediaButtonPTT(): void {
    if (!listening) return;

    if (isTalking) {
        stopTalking();
        isTalking = false;
        notifyListeners();
    }
    subscription?.remove();
    subscription = null;
    listening = false;
    console.log('[PTT] Media button PTT stopped');
}
