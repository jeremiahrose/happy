import React, { useEffect, useRef } from 'react';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { realtimeClientTools } from './realtimeClientTools';
import {
    OPENAI_VOICE,
    OPENAI_MODEL,
    OPENAI_AUDIO_FORMAT,
    OPENAI_SAMPLE_RATE,
    OPENAI_VOICE_TOOLS,
    getVoiceSystemPrompt,
} from './openaiVoiceConfig';
import type { VoiceSession, VoiceSessionConfig } from './types';
import {
    AudioContext as RNAudioContext,
    AudioRecorder,
    AudioBuffer as RNAudioBuffer,
    AudioManager,
} from 'react-native-audio-api';

/**
 * OpenAI Realtime API voice session for React Native.
 * Uses WebSocket + react-native-audio-api for mic capture and playback,
 * matching the web implementation's approach for better device compatibility.
 */

let ws: WebSocket | null = null;
let playbackContext: RNAudioContext | null = null;
let nextPlayTime = 0;
let recorder: AudioRecorder | null = null;
let isResponseActive = false;
let pendingResponseAction: (() => void) | null = null;

function float32ToBase64Pcm16(float32: Float32Array): string {
    const pcm16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    const bytes = new Uint8Array(pcm16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function playPcm16Base64(base64: string) {
    if (!playbackContext) return;

    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
    }

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

function humanizeOpenAIError(error: { type?: string; code?: string; message?: string }): string {
    const code = error?.code ?? '';
    const type = error?.type ?? '';
    if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' || type === 'insufficient_quota') {
        return 'Your OpenAI account has run out of credits. Please add funds at platform.openai.com.';
    }
    if (code === 'rate_limit_exceeded') {
        return 'OpenAI rate limit reached. Please wait a moment and try again.';
    }
    if (code === 'invalid_api_key') {
        return 'Your OpenAI API key is invalid. Please check your settings.';
    }
    return error?.message ?? 'An unexpected error occurred with the voice service.';
}

function sendWsMessage(data: Record<string, unknown>) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

/**
 * Creates a response, or queues it if one is already in-flight.
 * OpenAI's Realtime API rejects concurrent response.create calls.
 */
function createResponseOrQueue(action: () => void) {
    if (isResponseActive) {
        pendingResponseAction = action;
        return;
    }
    action();
}

function onResponseStarted() {
    isResponseActive = true;
}

function onResponseDone() {
    isResponseActive = false;
    if (pendingResponseAction) {
        const action = pendingResponseAction;
        pendingResponseAction = null;
        action();
    }
}

let audioChunkCount = 0;

function startRecording() {
    try {
        audioChunkCount = 0;
        recorder = new AudioRecorder({
            sampleRate: OPENAI_SAMPLE_RATE,
            bufferLengthInSamples: 2400,
        });

        recorder.onAudioReady((event: { buffer: RNAudioBuffer; numFrames: number; when: number }) => {
            audioChunkCount++;
            if (audioChunkCount <= 3 || audioChunkCount % 100 === 0) {
                console.log(`[Voice] Audio chunk #${audioChunkCount} - frames: ${event.numFrames}, channels: ${event.buffer.numberOfChannels}`);
            }
            const channelData = event.buffer.getChannelData(0);
            const base64 = float32ToBase64Pcm16(channelData);
            sendWsMessage({ type: 'input_audio_buffer.append', audio: base64 });
        });

        recorder.start();
        console.log('[Voice] AudioRecorder started');
    } catch (error) {
        console.error('[Voice] Failed to start recording:', error);
    }
}

function stopRecording() {
    if (recorder) {
        recorder.stop();
        recorder = null;
    }
}

async function handleToolCall(name: string, args: string, callId: string) {
    const toolFn = realtimeClientTools[name as keyof typeof realtimeClientTools];
    if (!toolFn) {
        console.error('[Voice] Unknown tool:', name);
        return;
    }

    try {
        const parsedArgs = JSON.parse(args || '{}');
        const result = await toolFn(parsedArgs);

        sendWsMessage({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: result,
            },
        });

        // Don't prompt GPT-4o to speak after forwarding a message — it should stay
        // silent until it receives a contextual update with Claude's response.
        if (name !== 'messageClaudeCode') {
            createResponseOrQueue(() => {
                onResponseStarted();
                sendWsMessage({
                    type: 'response.create',
                    response: {
                        modalities: ['text', 'audio'],
                        tool_choice: 'none',
                    },
                });
            });
        }
    } catch (error) {
        console.error('[Voice] Tool execution failed:', error);
    }
}

class RealtimeVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (ws) {
            console.warn('[Voice] Session already active');
            return;
        }

        try {
            storage.getState().setRealtimeStatus('connecting');

            // Request microphone permission
            const permStatus = await AudioManager.requestRecordingPermissions();
            if (permStatus !== 'Granted') {
                console.error('[Voice] Microphone permission denied:', permStatus);
                storage.getState().setRealtimeStatus('error');
                return;
            }

            playbackContext = new RNAudioContext({ sampleRate: OPENAI_SAMPLE_RATE });
            nextPlayTime = 0;

            // Get ephemeral token - RN WebSocket doesn't support subprotocol auth
            const tokenResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: OPENAI_MODEL,
                    voice: OPENAI_VOICE,
                }),
            });

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                console.error('[Voice] Failed to get ephemeral token:', tokenResponse.status, errorText);
                storage.getState().setRealtimeStatus('error');
                let parsed: { error?: { code?: string; type?: string; message?: string } } | null = null;
                try { parsed = JSON.parse(errorText); } catch {}
                const message = parsed?.error
                    ? humanizeOpenAIError(parsed.error)
                    : tokenResponse.status === 402 || tokenResponse.status === 429
                        ? 'Your OpenAI account has run out of credits. Please add funds at platform.openai.com.'
                        : t('errors.voiceServiceUnavailable');
                Modal.alert(t('common.error'), message);
                return;
            }

            const tokenData = await tokenResponse.json();
            const ephemeralKey = tokenData.client_secret?.value;
            if (!ephemeralKey) {
                console.error('[Voice] No ephemeral key in response:', JSON.stringify(tokenData));
                storage.getState().setRealtimeStatus('error');
                return;
            }

            console.log('[Voice] Got ephemeral token, connecting WebSocket...');

            const url = `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`;
            ws = new WebSocket(url, [
                'realtime',
                `openai-insecure-api-key.${ephemeralKey}`,
                'openai-beta.realtime-v1',
            ]);

            await new Promise<void>((resolve, reject) => {
                if (!ws) return reject(new Error('WebSocket not created'));

                const onMessage = (event: MessageEvent) => {
                    const data = JSON.parse(event.data);

                    if (data.type === 'session.created') {
                        let instructions = getVoiceSystemPrompt();
                        if (config.initialContext) {
                            instructions += '\n\nCurrent session context:\n' + config.initialContext;
                        }

                        sendWsMessage({
                            type: 'session.update',
                            session: {
                                voice: OPENAI_VOICE,
                                modalities: ['text', 'audio'],
                                input_audio_format: OPENAI_AUDIO_FORMAT,
                                output_audio_format: OPENAI_AUDIO_FORMAT,
                                turn_detection: {
                                    type: 'server_vad',
                                    threshold: 0.5,
                                    prefix_padding_ms: 300,
                                    silence_duration_ms: 500,
                                },
                                tools: OPENAI_VOICE_TOOLS,
                                instructions,
                                speed: 1.3,
                            },
                        });
                    }

                    if (data.type === 'session.updated') {
                        console.log('[Voice] Session configured');
                        resolve();
                        startRecording();
                        storage.getState().setRealtimeStatus('connected');
                        storage.getState().setRealtimeMode('idle');
                    }
                };

                ws.onmessage = onMessage;
                ws.onerror = (error: any) => {
                    console.error('[Voice] WebSocket error:', JSON.stringify(error));
                    console.error('[Voice] WebSocket error message:', error?.message);
                    reject(error);
                };
                ws.onclose = (event: any) => {
                    console.log('[Voice] WebSocket closed - code:', event?.code, 'reason:', event?.reason);
                    stopRecording();
                    isResponseActive = false;
                    pendingResponseAction = null;
                    storage.getState().setRealtimeStatus('disconnected');
                    storage.getState().setRealtimeMode('idle', true);
                    storage.getState().clearRealtimeModeDebounce();
                    ws = null;
                };

                // Replace onmessage after setup to handle ongoing events
                const setupDone = () => {
                    if (!ws) return;
                    ws.onmessage = (event: MessageEvent) => {
                        onMessage(event);
                        const data = JSON.parse(event.data);

                        if (data.type === 'response.audio.delta' && data.delta) {
                            playPcm16Base64(data.delta);
                        }

                        if (data.type === 'response.created') {
                            onResponseStarted();
                        }

                        if (data.type === 'response.done') {
                            if (data.response?.output) {
                                for (const item of data.response.output) {
                                    if (item.type === 'function_call' && item.call_id) {
                                        handleToolCall(item.name, item.arguments, item.call_id);
                                    }
                                }
                            }
                            storage.getState().setRealtimeMode('idle');
                            onResponseDone();
                        }

                        if (data.type === 'response.audio_transcript.delta') {
                            storage.getState().setRealtimeMode('speaking');
                        }

                        if (data.type === 'input_audio_buffer.speech_started') {
                            console.log('[Voice] Speech detected by server');
                        }

                        if (data.type === 'input_audio_buffer.speech_stopped') {
                            console.log('[Voice] Speech ended');
                        }

                        if (data.type === 'error') {
                            console.error('[Voice] API error:', JSON.stringify(data.error));
                            const message = humanizeOpenAIError(data.error);
                            storage.getState().setRealtimeStatus('error');
                            stopRecording();
                            if (ws) {
                                ws.close();
                                ws = null;
                            }
                            Modal.alert(t('common.error'), message);
                        }
                    };
                };

                // Set up full message handler after connection is established
                const origResolve = resolve;
                resolve = () => {
                    origResolve();
                    setupDone();
                };
            });
        } catch (error) {
            console.error('[Voice] Failed to start session:', error);
            storage.getState().setRealtimeStatus('error');
            if (ws) {
                ws.close();
                ws = null;
            }
        }
    }

    async endSession(): Promise<void> {
        stopRecording();
        if (ws) {
            ws.close();
            ws = null;
        }
        if (playbackContext) {
            playbackContext.close();
            playbackContext = null;
        }
        isResponseActive = false;
        pendingResponseAction = null;
        storage.getState().setRealtimeStatus('disconnected');
    }

    sendTextMessage(message: string): void {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        createResponseOrQueue(() => {
            sendWsMessage({
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: message }],
                },
            });
            onResponseStarted();
            sendWsMessage({ type: 'response.create' });
        });
    }

    sendContextualUpdate(update: string): void {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        // Inject context as a system-level conversation item
        sendWsMessage({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: update }],
            },
        });
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const hasRegistered = useRef(false);

    useEffect(() => {
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new RealtimeVoiceSessionImpl());
                hasRegistered.current = true;
                console.log('[Voice] Native voice session registered');
            } catch (error) {
                console.error('[Voice] Failed to register voice session:', error);
            }
        }
    }, []);

    return null;
};
