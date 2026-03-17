import React, { useEffect, useRef } from 'react';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import {
    OPENAI_VOICE,
    OPENAI_MODEL,
    OPENAI_VOICE_TOOLS,
    getVoiceSystemPrompt,
} from './openaiVoiceConfig';
import type { VoiceSession, VoiceSessionConfig } from './types';
import {
    RTCPeerConnection,
    mediaDevices,
    MediaStream as RNMediaStream,
    RTCSessionDescription,
} from '@livekit/react-native-webrtc';

/**
 * OpenAI Realtime API voice session for React Native.
 * Uses WebRTC transport so audio I/O is handled natively by the platform -
 * no manual PCM encoding/decoding needed.
 */

let peerConnection: RTCPeerConnection | null = null;
let dataChannel: any = null;
let localStream: RNMediaStream | null = null;
let isResponseActive = false;
let pendingResponseAction: (() => void) | null = null;

function sendDataChannelMessage(data: Record<string, unknown>) {
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify(data));
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

async function handleToolCall(name: string, args: string, callId: string) {
    const toolFn = realtimeClientTools[name as keyof typeof realtimeClientTools];
    if (!toolFn) {
        console.error('[Voice] Unknown tool:', name);
        return;
    }

    try {
        const parsedArgs = JSON.parse(args || '{}');
        const result = await toolFn(parsedArgs);

        sendDataChannelMessage({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: result,
            },
        });

        createResponseOrQueue(() => {
            onResponseStarted();
            sendDataChannelMessage({
                type: 'response.create',
                response: {
                    modalities: ['text', 'audio'],
                    tool_choice: 'none',
                },
            });
        });
    } catch (error) {
        console.error('[Voice] Tool execution failed:', error);
    }
}

class RealtimeVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (peerConnection) {
            console.warn('[Voice] Session already active');
            return;
        }

        try {
            storage.getState().setRealtimeStatus('connecting');

            // Step 1: Get ephemeral token from OpenAI
            const tokenResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: OPENAI_MODEL,
                    voice: OPENAI_VOICE,
                    modalities: ['text', 'audio'],
                    instructions: config.initialContext
                        ? getVoiceSystemPrompt() + '\n\nCurrent session context:\n' + config.initialContext
                        : getVoiceSystemPrompt(),
                    tools: OPENAI_VOICE_TOOLS,
                    input_audio_format: 'pcm16',
                    output_audio_format: 'pcm16',
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500,
                    },
                }),
            });

            if (!tokenResponse.ok) {
                throw new Error(`Failed to get ephemeral token: ${tokenResponse.status}`);
            }

            const tokenData = await tokenResponse.json();
            const ephemeralKey = tokenData.client_secret?.value;
            if (!ephemeralKey) {
                throw new Error('No ephemeral key in response');
            }

            // Step 2: Create RTCPeerConnection
            const pc = new RTCPeerConnection({});
            peerConnection = pc;

            // Step 3: Set up audio - get mic stream and add track
            const stream = await mediaDevices.getUserMedia({ audio: true }) as RNMediaStream;
            localStream = stream;
            for (const track of stream.getTracks()) {
                pc.addTrack(track, stream);
            }

            // Step 4: Handle remote audio track (playback is automatic via WebRTC)
            (pc as any).addEventListener('track', () => {
                console.log('[Voice] Remote audio track received');
                // WebRTC handles playback automatically on native
            });

            // Step 5: Create data channel for events
            dataChannel = pc.createDataChannel('oai-events');

            dataChannel.onopen = () => {
                console.log('[Voice] Data channel open');
                storage.getState().setRealtimeStatus('connected');
                storage.getState().setRealtimeMode('idle');
            };

            dataChannel.onmessage = (event: any) => {
                try {
                    const data = JSON.parse(event.data);

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
                } catch (e) {
                    console.error('[Voice] Failed to parse data channel message:', e);
                }
            };

            dataChannel.onclose = () => {
                console.log('[Voice] Data channel closed');
            };

            // Step 6: Create and set local SDP offer
            const offer = await pc.createOffer({});
            await pc.setLocalDescription(offer);

            // Step 7: Send offer to OpenAI and get answer
            const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${ephemeralKey}`,
                    'Content-Type': 'application/sdp',
                },
                body: pc.localDescription?.sdp,
            });

            if (!sdpResponse.ok) {
                throw new Error(`SDP exchange failed: ${sdpResponse.status}`);
            }

            const answerSdp = await sdpResponse.text();
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));

            console.log('[Voice] WebRTC session established');

            // Handle connection state changes
            (pc as any).addEventListener('connectionstatechange', () => {
                console.log('[Voice] Connection state:', pc.connectionState);
                if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                    this.cleanup();
                }
            });
        } catch (error) {
            console.error('[Voice] Failed to start session:', error);
            storage.getState().setRealtimeStatus('error');
            this.cleanup();
        }
    }

    private cleanup() {
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
        if (dataChannel) {
            dataChannel.close();
            dataChannel = null;
        }
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        isResponseActive = false;
        pendingResponseAction = null;
        storage.getState().setRealtimeStatus('disconnected');
        storage.getState().setRealtimeMode('idle', true);
        storage.getState().clearRealtimeModeDebounce();
    }

    async endSession(): Promise<void> {
        this.cleanup();
    }

    sendTextMessage(message: string): void {
        createResponseOrQueue(() => {
            sendDataChannelMessage({
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: message }],
                },
            });
            onResponseStarted();
            sendDataChannelMessage({ type: 'response.create' });
        });
    }

    sendContextualUpdate(update: string): void {
        sendDataChannelMessage({
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
