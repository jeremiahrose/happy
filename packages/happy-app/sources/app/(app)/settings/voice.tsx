import { useState } from 'react';
import { TextInput, View, Text } from 'react-native';
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
    const [openaiKey, setOpenaiKey] = useSettingMutable('inferenceOpenAIKey');
    const [keyVisible, setKeyVisible] = useState(false);

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* OpenAI API Key */}
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