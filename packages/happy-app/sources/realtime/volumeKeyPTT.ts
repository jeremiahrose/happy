import {
    VolumeKeyEvent,
    addVolumeKeyDownListener,
    addVolumeKeyUpListener,
    startVolumeKeyListening,
    stopVolumeKeyListening,
} from './volumeKey';
import { startTalking, stopTalking } from './RealtimeSession';

// Double-tap-and-hold gesture detection for volume-up PTT.
//
// The gesture:
// 1. Tap volume-up (press + release)
// 2. Within DOUBLE_TAP_WINDOW ms, press volume-up again and hold
// 3. PTT starts on the second press (after confirming it's a double-tap)
// 4. PTT ends when the key is released
//
// Single taps are ignored (volume change is suppressed while listening).

const DOUBLE_TAP_WINDOW = 400; // ms between first release and second press

type State =
    | { type: 'idle' }
    | { type: 'first_down'; timestamp: number }
    | { type: 'first_up'; timestamp: number }
    | { type: 'ptt_active' };

let state: State = { type: 'idle' };
let firstUpTimer: ReturnType<typeof setTimeout> | null = null;

let removeDownListener: (() => void) | null = null;
let removeUpListener: (() => void) | null = null;

function resetState() {
    state = { type: 'idle' };
    if (firstUpTimer) {
        clearTimeout(firstUpTimer);
        firstUpTimer = null;
    }
}

function handleKeyDown(event: VolumeKeyEvent) {
    if (event.direction !== 'up') return;

    switch (state.type) {
        case 'idle':
            state = { type: 'first_down', timestamp: event.timestamp };
            break;

        case 'first_up': {
            const elapsed = event.timestamp - state.timestamp;
            if (elapsed <= DOUBLE_TAP_WINDOW) {
                // Second press within window — activate PTT
                if (firstUpTimer) {
                    clearTimeout(firstUpTimer);
                    firstUpTimer = null;
                }
                state = { type: 'ptt_active' };
                startTalking();
            } else {
                // Too slow — treat as new first tap
                state = { type: 'first_down', timestamp: event.timestamp };
            }
            break;
        }

        case 'first_down':
        case 'ptt_active':
            // Ignore repeated downs
            break;
    }
}

function handleKeyUp(event: VolumeKeyEvent) {
    if (event.direction !== 'up') return;

    switch (state.type) {
        case 'first_down':
            // First tap completed — wait for second press
            state = { type: 'first_up', timestamp: event.timestamp };
            firstUpTimer = setTimeout(() => {
                // No second press came — reset
                resetState();
            }, DOUBLE_TAP_WINDOW);
            break;

        case 'ptt_active':
            // Released during PTT — end it
            stopTalking();
            resetState();
            break;

        case 'idle':
        case 'first_up':
            // Spurious up — ignore
            break;
    }
}

export async function startVolumeKeyPTT(): Promise<void> {
    resetState();
    await startVolumeKeyListening();
    removeDownListener = addVolumeKeyDownListener(handleKeyDown);
    removeUpListener = addVolumeKeyUpListener(handleKeyUp);
}

export async function stopVolumeKeyPTT(): Promise<void> {
    if (state.type === 'ptt_active') {
        stopTalking();
    }
    resetState();
    removeDownListener?.();
    removeUpListener?.();
    removeDownListener = null;
    removeUpListener = null;
    await stopVolumeKeyListening();
}
