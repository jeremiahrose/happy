import React, { useEffect, useRef } from 'react';
import { registerVoiceSession, getCurrentRealtimeSessionId } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { Modal } from '@/modal';
import { t } from '@/text';
import { stripVoicePrefix } from './hooks/contextFormatters';
import { voicePrompt } from '@/sync/prompt/systemPrompt';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { startVoiceForegroundService, stopVoiceForegroundService } from './foregroundService';
import { fetch as expoFetch } from 'expo/fetch';
import {
    AudioContext as RNAudioContext,
    AudioManager,
} from 'react-native-audio-api';
import {
    OPENAI_VOICE,
    OPENAI_SAMPLE_RATE,
    OPENAI_TTS_MODEL,
    OPENAI_TTS_SPEED,
    OPENAI_TTS_INSTRUCTIONS,
} from './openaiVoiceConfig';

/**
 * Local on-device voice session.
 * Uses sherpa-onnx Parakeet CTC model for on-device STT.
 * Uses OpenAI TTS API for speech output (requires API key).
 */

// Lazy imports for sherpa-onnx (only available on native)
let createStreamingSTT: any = null;
let createPcmLiveStream: any = null;
let ensureModelByCategory: any = null;
let ModelCategory: any = null;
let listModelsByCategory: any = null;
let getLocalModelPathByCategory: any = null;
let isModelDownloadedByCategory: any = null;

async function loadSherpaOnnx() {
    if (createStreamingSTT) return;
    const sttModule = require('react-native-sherpa-onnx/stt');
    const audioModule = require('react-native-sherpa-onnx/audio');
    const downloadModule = require('react-native-sherpa-onnx/download');
    createStreamingSTT = sttModule.createStreamingSTT;
    createPcmLiveStream = audioModule.createPcmLiveStream;
    ensureModelByCategory = downloadModule.ensureModelByCategory;
    ModelCategory = downloadModule.ModelCategory;
    listModelsByCategory = downloadModule.listModelsByCategory;
    getLocalModelPathByCategory = downloadModule.getLocalModelPathByCategory;
    isModelDownloadedByCategory = downloadModule.isModelDownloadedByCategory;
}

// Permission pattern matching (same as OpenAI session)
const ALLOW_PATTERNS = /^(yes|yeah|yep|approve|approved|allow|go ahead|do it|ok|okay|sure|go for it)[.!,]?$/i;
const DENY_PATTERNS = /^(no|nope|deny|reject|stop|cancel|don't|do not)[.!,]?$/i;

function tryHandlePermission(transcript: string): boolean {
    const sessionId = getCurrentRealtimeSessionId();
    if (!sessionId) return false;
    const session = storage.getState().sessions[sessionId];
    const requests = session?.agentState?.requests;
    if (!requests || Object.keys(requests).length === 0) return false;
    const requestId = Object.keys(requests)[0];
    const trimmed = transcript.trim();
    if (ALLOW_PATTERNS.test(trimmed)) { sessionAllow(sessionId, requestId); return true; }
    if (DENY_PATTERNS.test(trimmed)) { sessionDeny(sessionId, requestId); return true; }
    return false;
}

// TTS state (reuses OpenAI TTS REST API)
let playbackContext: RNAudioContext | null = null;
let nextPlayTime = 0;
let storedApiKey: string | null = null;
let ttsAbortController: AbortController | null = null;
let ttsQueue: string[] = [];
let ttsPlaying = false;
let pcmLeftover: Uint8Array | null = null;
let pcmAccumulator: Uint8Array[] = [];
let pcmAccumulatorBytes = 0;
const PCM_MIN_BUFFER_BYTES = 9600;

function schedulePcmBuffer(data: Uint8Array) {
    if (!playbackContext || data.length === 0) return;
    const usableLength = data.length - (data.length % 2);
    if (usableLength === 0) return;
    const aligned = data.slice(0, usableLength);
    const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, usableLength / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) { float32[i] = int16[i] / 32768; }
    const buffer = playbackContext.createBuffer(1, float32.length, OPENAI_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);
    const source = playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackContext.destination);
    const now = playbackContext.currentTime;
    const startTime = Math.max(now, nextPlayTime);
    source.start(startTime);
    nextPlayTime = startTime + buffer.duration;
}

function flushPcmAccumulator() {
    if (pcmAccumulatorBytes === 0) return;
    const merged = new Uint8Array(pcmAccumulatorBytes);
    let offset = 0;
    for (const chunk of pcmAccumulator) { merged.set(chunk, offset); offset += chunk.length; }
    pcmAccumulator = [];
    pcmAccumulatorBytes = 0;
    schedulePcmBuffer(merged);
}

function playPcm16Bytes(bytes: Uint8Array) {
    if (!playbackContext || bytes.length === 0) return;
    let data: Uint8Array;
    if (pcmLeftover) {
        data = new Uint8Array(pcmLeftover.length + bytes.length);
        data.set(pcmLeftover);
        data.set(bytes, pcmLeftover.length);
        pcmLeftover = null;
    } else {
        data = bytes;
    }
    if (data.length % 2 !== 0) {
        pcmLeftover = data.slice(data.length - 1);
        data = data.slice(0, data.length - 1);
        if (data.length === 0) return;
    }
    pcmAccumulator.push(data);
    pcmAccumulatorBytes += data.length;
    if (pcmAccumulatorBytes >= PCM_MIN_BUFFER_BYTES) { flushPcmAccumulator(); }
}

async function processTtsQueue() {
    if (ttsPlaying || ttsQueue.length === 0) return;
    ttsPlaying = true;
    while (ttsQueue.length > 0) {
        const text = ttsQueue.shift()!;
        try { await speakText(text); }
        catch (error) { if ((error as Error).name !== 'AbortError') console.error('[LocalVoice] TTS error:', error); }
    }
    ttsPlaying = false;
    storage.getState().setRealtimeMode('idle');
}

async function speakText(text: string) {
    if (!storedApiKey || !playbackContext) return;
    storage.getState().setRealtimeMode('agent-speaking');
    ttsAbortController = new AbortController();
    const response = await expoFetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${storedApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: OPENAI_TTS_MODEL, voice: OPENAI_VOICE, input: text,
            response_format: 'pcm', speed: OPENAI_TTS_SPEED, instructions: OPENAI_TTS_INSTRUCTIONS,
        }),
        signal: ttsAbortController.signal,
    });
    if (!response.ok) {
        const errorText = await response.text();
        console.error('[LocalVoice] TTS request failed:', response.status, errorText);
        return;
    }
    if (response.body) {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) playPcm16Bytes(value);
        }
        flushPcmAccumulator();
    }
    ttsAbortController = null;
}

function cancelTts() {
    ttsQueue = [];
    if (ttsAbortController) { ttsAbortController.abort(); ttsAbortController = null; }
    ttsPlaying = false;
    nextPlayTime = 0;
    pcmLeftover = null;
    pcmAccumulator = [];
    pcmAccumulatorBytes = 0;
}

// STT state
let sttEngine: any = null;
let sttStream: any = null;
let micStream: any = null;
let unsubMicData: (() => void) | null = null;
let unsubMicError: (() => void) | null = null;
let pushToTalkMode = false;
let isListening = false;

// Streaming Fast Conformer CTC int8 model (~95MB, 80ms latency)
const STT_MODEL_ID = 'sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms-int8';

async function ensureModel(): Promise<string> {
    await loadSherpaOnnx();

    // Check if already downloaded
    const downloaded = await isModelDownloadedByCategory(ModelCategory.Stt, STT_MODEL_ID);
    if (downloaded) {
        const localPath = await getLocalModelPathByCategory(ModelCategory.Stt, STT_MODEL_ID);
        console.log('[LocalVoice] Model already available at:', localPath);
        return localPath;
    }

    // List available models to find ours
    console.log('[LocalVoice] Checking available STT models...');
    const models = await listModelsByCategory(ModelCategory.Stt);
    const model = models.find((m: any) => m.id === STT_MODEL_ID);

    if (!model) {
        // Try to find any nemo/parakeet streaming model
        const nemoModels = models.filter((m: any) =>
            m.id.includes('nemo') || m.id.includes('parakeet') || m.id.includes('conformer')
        );
        console.log('[LocalVoice] Available NeMo/Parakeet models:', nemoModels.map((m: any) => m.id));
        throw new Error(`Model ${STT_MODEL_ID} not found in registry. Available NeMo models: ${nemoModels.map((m: any) => m.id).join(', ')}`);
    }

    console.log('[LocalVoice] Downloading model:', model.id, `(${(model.bytes / 1024 / 1024).toFixed(1)} MB)`);

    const result = await ensureModelByCategory(ModelCategory.Stt, STT_MODEL_ID, {
        onProgress: (progress: any) => {
            if (progress.percent % 10 < 1) {
                console.log(`[LocalVoice] Download: ${progress.percent.toFixed(0)}% (${progress.phase})`);
            }
        },
    });

    console.log('[LocalVoice] Model ready at:', result.localPath);
    return result.localPath;
}

async function initStt(modelPath: string) {
    await loadSherpaOnnx();

    sttEngine = await createStreamingSTT({
        modelPath: { type: 'file', path: modelPath },
        modelType: 'nemo_ctc',
        numThreads: 2,
        enableEndpoint: true,
        endpointConfig: {
            rule1: { mustContainNonSilence: false, minTrailingSilence: 2.0, minUtteranceLength: 0 },
            rule2: { mustContainNonSilence: true, minTrailingSilence: 1.0, minUtteranceLength: 0 },
            rule3: { mustContainNonSilence: false, minTrailingSilence: 0, minUtteranceLength: 20 },
        },
        debug: true,
    });

    sttStream = await sttEngine.createStream();
    console.log('[LocalVoice] STT engine initialized');
}

function startMicStream() {
    if (micStream) return;

    micStream = createPcmLiveStream({ sampleRate: 16000 });

    unsubMicData = micStream.onData((samples: Float32Array, sampleRate: number) => {
        if (!sttStream || !isListening) return;

        // Convert Float32Array to number[] for the bridge
        const arr = Array.from(samples);

        sttStream.processAudioChunk(arr, sampleRate).then(
            ({ result, isEndpoint }: { result: any; isEndpoint: boolean }) => {
                if (result.text && result.text.trim()) {
                    console.log('[LocalVoice] Partial:', result.text.trim());
                }

                if (isEndpoint && result.text && result.text.trim()) {
                    const transcript = result.text.trim();
                    console.log('[LocalVoice] Final transcript:', transcript);
                    storage.getState().setRealtimeMode('idle');

                    if (tryHandlePermission(transcript)) return;

                    const sessionId = getCurrentRealtimeSessionId();
                    if (sessionId) {
                        sync.sendMessage(sessionId, transcript, undefined, voicePrompt);
                    }

                    // Reset stream for next utterance
                    sttStream.reset();
                }
            }
        ).catch((err: any) => {
            console.error('[LocalVoice] STT processing error:', err);
        });
    });

    unsubMicError = micStream.onError((message: string) => {
        console.error('[LocalVoice] Mic error:', message);
    });

    micStream.start();
    isListening = true;
    console.log('[LocalVoice] Mic stream started');
}

function stopMicStream() {
    isListening = false;
    if (unsubMicData) { unsubMicData(); unsubMicData = null; }
    if (unsubMicError) { unsubMicError(); unsubMicError = null; }
    if (micStream) { micStream.stop(); micStream = null; }
}

class LocalVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<void> {
        try {
            storage.getState().setRealtimeStatus('connecting');
            storedApiKey = config.apiKey ?? null;
            pushToTalkMode = config.pushToTalk ?? false;

            // Request mic permission
            const permStatus = await AudioManager.requestRecordingPermissions();
            if (permStatus !== 'Granted') {
                console.error('[LocalVoice] Microphone permission denied:', permStatus);
                storage.getState().setRealtimeStatus('error');
                return;
            }

            // Set up audio playback for TTS
            playbackContext = new RNAudioContext({ sampleRate: OPENAI_SAMPLE_RATE });
            nextPlayTime = 0;
            AudioManager.setAudioSessionActivity(true);
            AudioManager.setLockScreenInfo({ title: 'Happy', description: 'Voice session active (local STT)', state: 'state_playing' });

            // Download/load STT model
            console.log('[LocalVoice] Ensuring STT model is available...');
            const modelPath = await ensureModel();

            // Initialize STT engine
            await initStt(modelPath);

            // Start foreground service for background operation
            startVoiceForegroundService();

            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');

            // Start listening if not push-to-talk
            if (!pushToTalkMode) {
                startMicStream();
            }

            console.log('[LocalVoice] Session started (pushToTalk:', pushToTalkMode, ')');
        } catch (error) {
            console.error('[LocalVoice] Failed to start session:', error);
            storage.getState().setRealtimeStatus('error');
            Modal.alert(t('common.error'), `Local voice session failed: ${(error as Error).message}`);
        }
    }

    async endSession(): Promise<void> {
        stopMicStream();
        stopVoiceForegroundService();
        cancelTts();

        if (sttStream) { await sttStream.release().catch(() => {}); sttStream = null; }
        if (sttEngine) { await sttEngine.destroy().catch(() => {}); sttEngine = null; }

        AudioManager.setAudioSessionActivity(false);
        AudioManager.resetLockScreenInfo();
        if (playbackContext) { playbackContext.close(); playbackContext = null; }
        storedApiKey = null;
        storage.getState().setRealtimeStatus('disconnected');
    }

    startTalking(): void {
        if (!pushToTalkMode) return;
        cancelTts();
        startMicStream();
        storage.getState().setRealtimeMode('user-speaking');
    }

    stopTalking(): void {
        if (!pushToTalkMode) return;
        stopMicStream();
        // Flush any remaining audio through STT
        if (sttStream) {
            sttStream.inputFinished().then(() => {
                return sttStream.getResult();
            }).then((result: any) => {
                if (result.text && result.text.trim()) {
                    const transcript = result.text.trim();
                    console.log('[LocalVoice] Final on stop:', transcript);
                    if (!tryHandlePermission(transcript)) {
                        const sessionId = getCurrentRealtimeSessionId();
                        if (sessionId) {
                            sync.sendMessage(sessionId, transcript, undefined, voicePrompt);
                        }
                    }
                }
                // Reset for next utterance
                sttStream.reset();
            }).catch((err: any) => {
                console.error('[LocalVoice] Error flushing STT on stop:', err);
            });
        }
        storage.getState().setRealtimeMode('idle');
    }

    sendTextMessage(message: string): void {
        if (!storedApiKey) {
            console.log('[LocalVoice] No API key for TTS, skipping speech output');
            return;
        }
        let text = stripVoicePrefix(message);
        if (!text) return;
        text = text.replace(/<options>[\s\S]*?<\/options>/g, '').trim();
        if (!text) return;
        ttsQueue.push(text);
        processTtsQueue();
    }

    sendContextualUpdate(_update: string): void {
        // Local STT doesn't support prompt/context injection like OpenAI whisper
        // Could potentially use hotwords in the future
    }
}

export const LocalVoiceSession: React.FC = () => {
    const hasRegistered = useRef(false);

    useEffect(() => {
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new LocalVoiceSessionImpl());
                hasRegistered.current = true;
                console.log('[LocalVoice] Local voice session registered');
            } catch (error) {
                console.error('[LocalVoice] Failed to register voice session:', error);
            }
        }
    }, []);

    return null;
};
