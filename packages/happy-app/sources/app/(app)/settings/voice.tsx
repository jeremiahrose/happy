import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { t } from '@/text';

export default function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [voiceBackend, setVoiceBackend] = useSettingMutable('voiceBackend');
    const [openaiKey, setOpenaiKey] = useSettingMutable('inferenceOpenAIKey');
    const [keyVisible, setKeyVisible] = useState(false);

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Voice Backend */}
            <ItemGroup
                title={t('settingsVoice.backendTitle')}
                footer={t('settingsVoice.backendDescription')}
            >
                <Item
                    title="ElevenLabs"
                    subtitle={t('settingsVoice.backendElevenLabsSubtitle')}
                    selected={voiceBackend === 'elevenlabs'}
                    onPress={() => setVoiceBackend('elevenlabs')}
                />
                <Item
                    title="OpenAI GPT-4o"
                    subtitle={t('settingsVoice.backendOpenAISubtitle')}
                    selected={voiceBackend === 'openai'}
                    onPress={() => setVoiceBackend('openai')}
                />
            </ItemGroup>

            {/* OpenAI API Key - only shown when OpenAI backend is selected */}
            {voiceBackend === 'openai' && (
                <ItemGroup
                    title={t('settingsVoice.apiKeyTitle')}
                    footer={t('settingsVoice.apiKeyDescription')}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Ionicons name="key-outline" size={29} color="#007AFF" style={{ marginRight: 12 }} />
                        <TextInput
                            style={{
                                flex: 1,
                                fontSize: 16,
                                color: theme.colors.text,
                            }}
                            placeholder={t('settingsVoice.apiKeyPlaceholder')}
                            placeholderTextColor={theme.colors.input?.placeholder ?? '#999'}
                            value={openaiKey ?? ''}
                            onChangeText={(text) => setOpenaiKey(text || null)}
                            secureTextEntry={!keyVisible}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="off"
                        />
                        <Ionicons
                            name={keyVisible ? 'eye-off-outline' : 'eye-outline'}
                            size={22}
                            color={theme.colors.textSecondary}
                            onPress={() => setKeyVisible(!keyVisible)}
                            style={{ marginLeft: 8, padding: 4 }}
                        />
                    </View>
                </ItemGroup>
            )}

            {/* Language Settings */}
            <ItemGroup
                title={t('settingsVoice.languageTitle')}
                footer={t('settingsVoice.languageDescription')}
            >
                <Item
                    title={t('settingsVoice.preferredLanguage')}
                    subtitle={t('settingsVoice.preferredLanguageSubtitle')}
                    icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                    detail={getLanguageDisplayName(currentLanguage)}
                    onPress={() => router.push('/settings/voice/language')}
                />
            </ItemGroup>

        </ItemList>
    );
}
