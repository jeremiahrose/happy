const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin that adds an Android AccessibilityService for volume key interception.
 *
 * This plugin:
 * 1. Registers the AccessibilityService in the AndroidManifest
 * 2. Copies the native Kotlin source files into the generated android project
 * 3. Adds the accessibility service config XML and string resource
 */
const withVolumeKey = (config) => {
    // Step 1: Modify AndroidManifest.xml
    config = withAndroidManifest(config, (manifestConfig) => {
        const manifest = manifestConfig.modResults.manifest;
        const application = manifest.application?.[0];
        if (!application) return manifestConfig;

        if (!application.service) {
            application.service = [];
        }

        const serviceName = '.volumekey.VolumeKeyService';
        const exists = application.service.find(
            (s) => s.$?.['android:name'] === serviceName
        );
        if (!exists) {
            application.service.push({
                $: {
                    'android:name': serviceName,
                    'android:exported': 'false',
                    'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
                },
                'intent-filter': [
                    {
                        action: [
                            {
                                $: {
                                    'android:name': 'android.accessibilityservice.AccessibilityService',
                                },
                            },
                        ],
                    },
                ],
                'meta-data': [
                    {
                        $: {
                            'android:name': 'android.accessibilityservice',
                            'android:resource': '@xml/volume_key_service_config',
                        },
                    },
                ],
            });
        }

        console.log('✅ Volume key plugin: manifest updated');
        return manifestConfig;
    });

    // Step 2: Copy native files
    config = withDangerousMod(config, [
        'android',
        async (dangerousConfig) => {
            const projectRoot = dangerousConfig.modRequest.projectRoot;
            const packageName = dangerousConfig.android?.package || 'com.slopus.happy.dev';
            const packagePath = packageName.replace(/\./g, '/');

            const sourceDir = path.join(
                projectRoot,
                'plugins',
                'volume-key-native'
            );

            // Copy Kotlin source files
            const destDir = path.join(
                projectRoot,
                'android',
                'app',
                'src',
                'main',
                'java',
                packagePath,
                'volumekey'
            );
            fs.mkdirSync(destDir, { recursive: true });

            const kotlinFiles = [
                'VolumeKeyService.kt',
                'VolumeKeyModule.kt',
                'VolumeKeyPackage.kt',
            ];

            for (const file of kotlinFiles) {
                const src = path.join(sourceDir, file);
                if (!fs.existsSync(src)) {
                    console.warn(`⚠️ Volume key plugin: missing ${file}`);
                    continue;
                }
                let content = fs.readFileSync(src, 'utf8');
                content = content.replace(
                    /package __PACKAGE__\.volumekey/g,
                    `package ${packageName}.volumekey`
                );
                content = content.replace(/__PACKAGE__/g, packageName);
                fs.writeFileSync(path.join(destDir, file), content, 'utf8');
            }

            // Copy accessibility service config XML
            const xmlDestDir = path.join(
                projectRoot,
                'android',
                'app',
                'src',
                'main',
                'res',
                'xml'
            );
            fs.mkdirSync(xmlDestDir, { recursive: true });
            const xmlSrc = path.join(sourceDir, 'volume_key_service_config.xml');
            if (fs.existsSync(xmlSrc)) {
                fs.copyFileSync(xmlSrc, path.join(xmlDestDir, 'volume_key_service_config.xml'));
            }

            // Add string resource for accessibility service description
            const stringsPath = path.join(
                projectRoot,
                'android',
                'app',
                'src',
                'main',
                'res',
                'values',
                'strings.xml'
            );
            if (fs.existsSync(stringsPath)) {
                let strings = fs.readFileSync(stringsPath, 'utf8');
                if (!strings.includes('volume_key_service_description')) {
                    strings = strings.replace(
                        '</resources>',
                        '    <string name="volume_key_service_description">Allows Happy to use the volume button for push-to-talk, even when the screen is off.</string>\n</resources>'
                    );
                    fs.writeFileSync(stringsPath, strings, 'utf8');
                }
            }

            // Register the package in MainApplication
            const mainAppPath = path.join(
                projectRoot,
                'android',
                'app',
                'src',
                'main',
                'java',
                packagePath,
                'MainApplication.kt'
            );

            if (fs.existsSync(mainAppPath)) {
                let mainApp = fs.readFileSync(mainAppPath, 'utf8');
                const importLine = `import ${packageName}.volumekey.VolumeKeyPackage`;
                const addLine = `packages.add(VolumeKeyPackage())`;

                if (!mainApp.includes('VolumeKeyPackage')) {
                    mainApp = mainApp.replace(
                        /(import [^\n]+\n)(?!import)/,
                        `$1${importLine}\n`
                    );
                    mainApp = mainApp.replace(
                        /(val packages = PackageList\(this\)\.packages)/,
                        `$1\n            ${addLine}`
                    );
                    fs.writeFileSync(mainAppPath, mainApp, 'utf8');
                }
            }

            console.log('✅ Volume key plugin: native files copied');
            return dangerousConfig;
        },
    ]);

    return config;
};

module.exports = withVolumeKey;
