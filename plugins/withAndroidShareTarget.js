const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const SHARED_DOCUMENT_SOURCE = String.raw`package ai.healz.mobile

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ViewManager
import java.io.ByteArrayOutputStream

private const val MAX_SHARED_FILE_BYTES = 12 * 1024 * 1024

object SharedDocumentStore {
  private var pendingIntent: Intent? = null

  fun capture(intent: Intent?) {
    if (intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE) {
      pendingIntent = Intent(intent)
    }
  }

  fun clear() {
    pendingIntent = null
  }

  fun readFirstSharedDocument(context: Context): WritableMap? {
    val intent = pendingIntent ?: return null
    val uri = extractUris(intent).firstOrNull() ?: return null
    val resolver = context.contentResolver
    val mimeType = resolver.getType(uri) ?: intent.type ?: "application/octet-stream"

    if (!mimeType.startsWith("image/") && mimeType != "application/pdf") {
      throw IllegalArgumentException("Only PDF and image files are supported.")
    }

    val bytes = readBytes(resolver, uri)
    val metadata = readMetadata(resolver, uri)
    val name = metadata.first ?: uri.lastPathSegment ?: "healz-document"
    val size = metadata.second ?: bytes.size.toLong()

    return Arguments.createMap().apply {
      putString("uri", uri.toString())
      putString("name", name)
      putString("type", mimeType)
      putDouble("size", size.toDouble())
      putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }
  }

  @Suppress("DEPRECATION")
  private fun extractUris(intent: Intent): List<Uri> {
    return when (intent.action) {
      Intent.ACTION_SEND -> {
        val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        listOfNotNull(uri)
      }
      Intent.ACTION_SEND_MULTIPLE -> {
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.toList().orEmpty()
      }
      else -> emptyList()
    }
  }

  private fun readBytes(resolver: ContentResolver, uri: Uri): ByteArray {
    resolver.openInputStream(uri).use { input ->
      requireNotNull(input) { "Could not open shared file." }
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      var total = 0

      while (true) {
        val read = input.read(buffer)
        if (read == -1) break
        total += read
        if (total > MAX_SHARED_FILE_BYTES) {
          throw IllegalArgumentException("File is larger than 12 MB. Please choose a smaller file.")
        }
        output.write(buffer, 0, read)
      }

      return output.toByteArray()
    }
  }

  private fun readMetadata(resolver: ContentResolver, uri: Uri): Pair<String?, Long?> {
    var cursor: Cursor? = null
    return try {
      cursor = resolver.query(uri, null, null, null, null)
      if (cursor != null && cursor.moveToFirst()) {
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        val name = if (nameIndex >= 0) cursor.getString(nameIndex) else null
        val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex) else null
        Pair(name, size)
      } else {
        Pair(null, null)
      }
    } finally {
      cursor?.close()
    }
  }
}

class SharedDocumentModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "SharedDocument"

  @ReactMethod
  fun getPendingShare(promise: Promise) {
    try {
      promise.resolve(SharedDocumentStore.readFirstSharedDocument(reactContext))
    } catch (error: Exception) {
      promise.reject("SHARED_DOCUMENT_ERROR", error.message, error)
    }
  }

  @ReactMethod
  fun clearPendingShare() {
    SharedDocumentStore.clear()
  }
}

class SharedDocumentPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    return listOf(SharedDocumentModule(reactContext))
  }

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> {
    return emptyList()
  }
}
`;

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
  const marker = 'android.intent.action.SEND_MULTIPLE';
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
    addOnce(manifest, marker, intentFilters, '    </activity>\n')
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
    '    SharedDocumentStore.capture(intent)\n',
    '    super.onCreate(null)\n'
  );

  source = addOnce(
    source,
    'override fun onNewIntent(intent: Intent)',
    `  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    SharedDocumentStore.capture(intent)
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
  const packagePath = path.join(
    projectRoot,
    'android/app/src/main/java/ai/healz/mobile/SharedDocumentPackage.kt'
  );
  fs.writeFileSync(packagePath, SHARED_DOCUMENT_SOURCE);
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
