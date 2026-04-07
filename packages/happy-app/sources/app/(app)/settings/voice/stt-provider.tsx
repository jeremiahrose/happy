import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';

const PROVIDERS = [
    {
        key: 'openai' as const,
        title: 'OpenAI Whisper',
        subtitle: () => t('settingsVoice.sttOpenAISubtitle'),
    },
    {
        key: 'deepgram' as const,
        title: 'Deepgram Nova-3',
        subtitle: () => t('settingsVoice.sttDeepgramSubtitle'),
    },
];

export default function SttProviderScreen() {
    const router = useRouter();
    const [voiceSttProvider, setVoiceSttProvider] = useSettingMutable('voiceSttProvider');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsVoice.sttProviderTitle')}
                footer={t('settingsVoice.sttProviderDescription')}
            >
                {PROVIDERS.map((provider) => (
                    <Item
                        key={provider.key}
                        title={provider.title}
                        subtitle={provider.subtitle()}
                        icon={<Ionicons name="ear-outline" size={29} color="#007AFF" />}
                        rightElement={
                            voiceSttProvider === provider.key ? (
                                <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                            ) : null
                        }
                        onPress={() => {
                            setVoiceSttProvider(provider.key);
                            if (router.canGoBack()) {
                                router.back();
                            }
                        }}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
}
