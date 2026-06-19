import React from 'react';
import { ElevenLabsProvider } from '@elevenlabs/react-native';
import { ElevenLabsVoiceSession } from './ElevenLabsVoiceSession';
import { OpenAIVoiceSession } from './OpenAIVoiceSession';
import { LocalVoiceSession } from './LocalVoiceSession';
import { useSetting } from '@/sync/storage';

function VoiceSessionForBackend({ backend }: { backend: string }) {
    if (backend === 'local') return <LocalVoiceSession />;
    if (backend === 'openai') return <OpenAIVoiceSession />;
    return <ElevenLabsVoiceSession />;
}

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    const voiceBackend = useSetting('voiceBackend');

    return (
        <ElevenLabsProvider>
            <VoiceSessionForBackend backend={voiceBackend} />
            {children}
        </ElevenLabsProvider>
    );
};
