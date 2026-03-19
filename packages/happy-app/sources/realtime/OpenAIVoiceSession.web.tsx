import React, { useEffect, useRef } from 'react';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
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

/**
 * OpenAI Realtime API voice session for web.
 * Uses WebSocket for the Realtime API and Web Audio API for mic capture + playback.
 */

let ws: WebSocket | null = null;
let playbackContext: AudioContext | null = null;
let nextPlayTime = 0;
let mediaStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let recordingContext: AudioContext | null = null;
let isResponseActive = false;
let pendingResponseQueue: (() => void)[] = [];

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

function sendWsMessage(data: Record<string, unknown>) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

/**
 * Creates a response, or queues it if one is already in-flight.
 * OpenAI's Realtime API rejects concurrent response.create calls.
 * Uses a FIFO queue so no events are dropped when multiple arrive during a response.
 */
function createResponseOrQueue(action: () => void) {
    if (isResponseActive) {
        pendingResponseQueue.push(action);
        return;
    }
    action();
}

function onResponseStarted() {
    isResponseActive = true;
}

function onResponseDone() {
    isResponseActive = false;
    if (pendingResponseQueue.length > 0) {
        const action = pendingResponseQueue.shift()!;
        action();
    }
}

async function startRecording() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordingContext = new AudioContext({ sampleRate: OPENAI_SAMPLE_RATE });
        const source = recordingContext.createMediaStreamSource(mediaStream);

        const workletCode = `
            class PCMProcessor extends AudioWorkletProcessor {
                process(inputs) {
                    const input = inputs[0];
                    if (input.length > 0) {
                        const channelData = input[0];
                        const pcm16 = new Int16Array(channelData.length);
                        for (let i = 0; i < channelData.length; i++) {
                            const s = Math.max(-1, Math.min(1, channelData[i]));
                            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                        }
                        this.port.postMessage({ pcm16 });
                    }
                    return true;
                }
            }
            registerProcessor('pcm-processor', PCMProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await recordingContext.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        workletNode = new AudioWorkletNode(recordingContext, 'pcm-processor');
        workletNode.port.onmessage = (event) => {
            if (event.data.pcm16) {
                const bytes = new Uint8Array(event.data.pcm16.buffer);
                let binary = '';
                for (let i = 0; i < bytes.length; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                const base64 = btoa(binary);
                sendWsMessage({ type: 'input_audio_buffer.append', audio: base64 });
            }
        };

        source.connect(workletNode);
    } catch (error) {
        console.error('[Voice] Failed to start recording:', error);
    }
}

function stopRecording() {
    if (workletNode) {
        workletNode.disconnect();
        workletNode = null;
    }
    if (recordingContext) {
        recordingContext.close();
        recordingContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
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
            try {
                await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (error) {
                console.error('[Voice] Microphone permission denied:', error);
                storage.getState().setRealtimeStatus('error');
                return;
            }

            playbackContext = new AudioContext({ sampleRate: OPENAI_SAMPLE_RATE });
            nextPlayTime = 0;

            const url = `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`;
            ws = new WebSocket(url, [
                'realtime',
                `openai-insecure-api-key.${config.apiKey}`,
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
                ws.onerror = (error) => {
                    console.error('[Voice] WebSocket error:', error);
                    reject(error);
                };
                ws.onclose = () => {
                    console.log('[Voice] WebSocket closed');
                    stopRecording();
                    isResponseActive = false;
                    pendingResponseQueue = [];
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

                        if (data.type === 'error') {
                            console.error('[Voice] API error:', data.error);
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

export const OpenAIVoiceSession: React.FC = () => {
    const hasRegistered = useRef(false);

    useEffect(() => {
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new RealtimeVoiceSessionImpl());
                hasRegistered.current = true;
                console.log('[Voice] Web voice session registered');
            } catch (error) {
                console.error('[Voice] Failed to register voice session:', error);
            }
        }
    }, []);

    return null;
};
