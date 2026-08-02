const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

function addOnce(source, marker, insertion, anchor) {
  if (source.includes(marker)) {
    return source;
  }

  if (!source.includes(anchor)) {
    throw new Error(`Could not find Android source anchor: ${anchor}`);
  }

  return source.replace(anchor, `${insertion}${anchor}`);
}

function updateAndroidManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml');
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  const intentFilters = `      <intent-filter>
        <action android:name="android.intent.action.SEND"/>
        <category android:name="android.intent.category.DEFAULT"/>
        <data android:mimeType="image/*"/>
        <data android:mimeType="application/pdf"/>
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.SEND_MULTIPLE"/>
        <category android:name="android.intent.category.DEFAULT"/>
        <data android:mimeType="image/*"/>
        <data android:mimeType="application/pdf"/>
      </intent-filter>
`;

  if (!manifest.includes('android.permission.READ_MEDIA_IMAGES')) {
    manifest = manifest.replace(
      '  <uses-permission android:name="android.permission.INTERNET"/>\n',
      '  <uses-permission android:name="android.permission.INTERNET"/>\n  <uses-permission android:name="android.permission.READ_MEDIA_IMAGES"/>\n'
    );
  }

  fs.writeFileSync(
    manifestPath,
    addOnce(
      manifest,
      'android.intent.action.SEND_MULTIPLE',
      intentFilters,
      '    </activity>\n'
    )
  );
}

function updateMainActivity(projectRoot) {
  const activityPath = path.join(
    projectRoot,
    'android/app/src/main/java/ai/healz/mobile/MainActivity.kt'
  );
  let source = fs.readFileSync(activityPath, 'utf8');

  source = addOnce(
    source,
    'import android.content.Intent',
    'import android.content.Intent\n',
    'import android.os.Build\n'
  );

  source = addOnce(
    source,
    'SharedDocumentStore.capture(intent)',
    '    SharedDocumentStore.capture(this, intent)\n',
    '    super.onCreate(null)\n'
  );

  source = addOnce(
    source,
    'override fun onNewIntent(intent: Intent)',
    `  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    SharedDocumentStore.capture(this, intent)
  }

`,
    '  /**\n   * Returns the name of the main component registered from JavaScript.'
  );

  fs.writeFileSync(activityPath, source);
}

function updateMainApplication(projectRoot) {
  const applicationPath = path.join(
    projectRoot,
    'android/app/src/main/java/ai/healz/mobile/MainApplication.kt'
  );
  const source = fs.readFileSync(applicationPath, 'utf8');

  fs.writeFileSync(
    applicationPath,
    addOnce(
      source,
      'add(SharedDocumentPackage())',
      '          add(SharedDocumentPackage())\n',
      '          // Packages that cannot be autolinked yet can be added manually here, for example:\n'
    )
  );
}

function writeSharedDocumentPackage(projectRoot) {
  const templatePath = path.join(__dirname, 'android/SharedDocumentPackage.kt');
  const packagePath = path.join(
    projectRoot,
    'android/app/src/main/java/ai/healz/mobile/SharedDocumentPackage.kt'
  );

  fs.writeFileSync(packagePath, fs.readFileSync(templatePath, 'utf8'));
}

module.exports = function withAndroidShareTarget(config) {
  return withDangerousMod(config, [
    'android',
    (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      updateAndroidManifest(projectRoot);
      updateMainActivity(projectRoot);
      updateMainApplication(projectRoot);
      writeSharedDocumentPackage(projectRoot);
      return modConfig;
    },
  ]);
};
