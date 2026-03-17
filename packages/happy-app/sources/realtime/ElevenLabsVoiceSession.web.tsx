import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import type { VoiceSession, VoiceSessionConfig } from './types';

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null;

// Global voice session implementation
class ElevenLabsVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<void> {
        console.log('[ElevenLabsVoiceSession] conversationInstance:', conversationInstance);
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized - conversationInstance is null');
            return;
        }

        try {
            storage.getState().setRealtimeStatus('connecting');

            // Request microphone permission first
            try {
                await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (error) {
                console.error('Failed to get microphone permission:', error);
                storage.getState().setRealtimeStatus('error');
                return;
            }

            // Get user's preferred language for voice assistant
            const userLanguagePreference = storage.getState().settings.voiceAssistantLanguage;
            const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);

            if (!config.token && !config.agentId) {
                throw new Error('Neither token nor agentId provided');
            }

            const sessionConfig: any = {
                connectionType: 'webrtc',
                dynamicVariables: {
                    sessionId: config.sessionId,
                    initialConversationContext: config.initialContext || ''
                },
                overrides: {
                    agent: {
                        language: elevenLabsLanguage
                    }
                },
                ...(config.token ? { conversationToken: config.token } : { agentId: config.agentId })
            };

            const conversationId = await conversationInstance.startSession(sessionConfig);
            console.log('Started conversation with ID:', conversationId);
        } catch (error) {
            console.error('Failed to start realtime session:', error);
            storage.getState().setRealtimeStatus('error');
        }
    }

    async endSession(): Promise<void> {
        if (!conversationInstance) {
            return;
        }

        try {
            await conversationInstance.endSession();
            storage.getState().setRealtimeStatus('disconnected');
        } catch (error) {
            console.error('Failed to end realtime session:', error);
        }
    }

    sendTextMessage(message: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        conversationInstance.sendUserMessage(message);
    }

    sendContextualUpdate(update: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        conversationInstance.sendContextualUpdate(update);
    }
}

export const ElevenLabsVoiceSession: React.FC = () => {
    const conversation = useConversation({
        clientTools: realtimeClientTools,
        onConnect: () => {
            console.log('Realtime session connected');
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
        },
        onDisconnect: () => {
            console.log('Realtime session disconnected');
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true);
            storage.getState().clearRealtimeModeDebounce();
        },
        onMessage: (data) => {
            console.log('Realtime message:', data);
        },
        onError: (error) => {
            console.warn('Realtime voice not available:', error);
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true);
        },
        onStatusChange: (data) => {
            console.log('Realtime status change:', data);
        },
        onModeChange: (data) => {
            console.log('Realtime mode change:', data);
            const mode = data.mode as string;
            const isSpeaking = mode === 'speaking';
            storage.getState().setRealtimeMode(isSpeaking ? 'speaking' : 'idle');
        },
        onDebug: (message) => {
            console.debug('Realtime debug:', message);
        }
    });

    const hasRegistered = useRef(false);

    useEffect(() => {
        console.log('[ElevenLabsVoiceSession] Setting conversationInstance:', conversation);
        conversationInstance = conversation;

        if (!hasRegistered.current) {
            try {
                console.log('[ElevenLabsVoiceSession] Registering voice session');
                registerVoiceSession(new ElevenLabsVoiceSessionImpl());
                hasRegistered.current = true;
                console.log('[ElevenLabsVoiceSession] Voice session registered successfully');
            } catch (error) {
                console.error('Failed to register voice session:', error);
            }
        }

        return () => {
            conversationInstance = null;
        };
    }, [conversation]);

    return null;
};
