import './sources/unistyles';
import { AppRegistry, Platform } from 'react-native';
import 'expo-router/entry';

// Register headless JS task to keep the JS thread alive
// when the voice foreground service is running in background
if (Platform.OS === 'android') {
    AppRegistry.registerHeadlessTask('VoiceKeepAlive', () => async () => {
        await new Promise<void>(() => {});
    });
}