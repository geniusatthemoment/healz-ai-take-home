package ai.healz.mobile

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
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
import kotlin.math.max
import kotlin.math.roundToInt

private const val MAX_SHARED_FILE_BYTES = 12 * 1024 * 1024
private const val IMAGE_COMPRESSION_THRESHOLD_BYTES = 1536 * 1024
private const val IMAGE_TARGET_BYTES = 2 * 1024 * 1024
private const val IMAGE_MAX_LONG_SIDE = 2400
private val IMAGE_QUALITY_STEPS = intArrayOf(90, 86, 82)

private data class PreparedDocument(
  val bytes: ByteArray,
  val name: String,
  val type: String,
  val originalSize: Int,
  val compressed: Boolean
)

private data class SharedDocumentPayload(
  val map: WritableMap,
  val originalSize: Int,
  val preparedSize: Int,
  val compressed: Boolean
)

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
    val uris = extractUris(intent)
    if (uris.isEmpty()) {
      return null
    }

    Log.i("SharedDocument", "Received ${uris.size} shared URI(s).")
    val documents = Arguments.createArray()
    var totalOriginalSize = 0L
    var totalPreparedSize = 0L
    var compressedCount = 0

    uris.forEach { uri ->
      val document = readSharedDocument(context, intent, uri)
      documents.pushMap(document.map)
      totalOriginalSize += document.originalSize.toLong()
      totalPreparedSize += document.preparedSize.toLong()
      if (document.compressed) {
        compressedCount += 1
      }
    }

    return Arguments.createMap().apply {
      putArray("documents", documents)
      putInt("count", uris.size)
      putDouble("size", totalPreparedSize.toDouble())
      putDouble("originalSize", totalOriginalSize.toDouble())
      putInt("compressedCount", compressedCount)
      putBoolean("compressed", compressedCount > 0)
      putDouble(
        "compressionRatio",
        if (totalOriginalSize > 0) totalPreparedSize.toDouble() / totalOriginalSize.toDouble() else 1.0
      )
    }
  }

  private fun readSharedDocument(
    context: Context,
    intent: Intent,
    uri: Uri
  ): SharedDocumentPayload {
    val resolver = context.contentResolver
    val mimeType = resolver.getType(uri) ?: intent.type ?: "application/octet-stream"

    if (!mimeType.startsWith("image/") && mimeType != "application/pdf") {
      throw IllegalArgumentException("Only PDF and image files are supported.")
    }

    val originalBytes = readBytes(resolver, uri)
    val metadata = readMetadata(resolver, uri)
    val originalName = metadata.first ?: uri.lastPathSegment ?: "healz-document"
    val prepared = prepareDocument(originalBytes, originalName, mimeType)
    val map = Arguments.createMap().apply {
      putString("uri", uri.toString())
      putString("name", prepared.name)
      putString("type", prepared.type)
      putDouble("size", prepared.bytes.size.toDouble())
      putDouble("originalSize", prepared.originalSize.toDouble())
      putBoolean("compressed", prepared.compressed)
      putDouble("compressionRatio", prepared.bytes.size.toDouble() / prepared.originalSize.toDouble())
      putString("base64", Base64.encodeToString(prepared.bytes, Base64.NO_WRAP))
    }

    return SharedDocumentPayload(
      map = map,
      originalSize = prepared.originalSize,
      preparedSize = prepared.bytes.size,
      compressed = prepared.compressed
    )
  }

  @Suppress("DEPRECATION")
  private fun extractUris(intent: Intent): List<Uri> {
    return when (intent.action) {
      Intent.ACTION_SEND -> {
        val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        listOfNotNull(uri)
      }
      Intent.ACTION_SEND_MULTIPLE -> {
        val parcelableUris = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
        if (!parcelableUris.isNullOrEmpty()) {
          return parcelableUris.toList()
        }

        intent.getStringArrayExtra(Intent.EXTRA_STREAM)
          ?.mapNotNull { value -> runCatching { Uri.parse(value) }.getOrNull() }
          .orEmpty()
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

  private fun prepareDocument(
    bytes: ByteArray,
    name: String,
    mimeType: String
  ): PreparedDocument {
    if (!mimeType.startsWith("image/") || bytes.size <= IMAGE_COMPRESSION_THRESHOLD_BYTES) {
      Log.i("SharedDocument", "Keeping original shared document (${bytes.size} bytes, type=$mimeType).")
      return PreparedDocument(bytes, name, mimeType, bytes.size, compressed = false)
    }

    val compressed = compressImage(bytes, name)?.takeIf { compressed ->
      compressed.bytes.size < bytes.size
    }

    if (compressed == null) {
      Log.i("SharedDocument", "Keeping original shared document because compression was not beneficial.")
      return PreparedDocument(bytes, name, mimeType, bytes.size, compressed = false)
    }

    Log.i(
      "SharedDocument",
      "Compressed shared document from ${bytes.size} to ${compressed.bytes.size} bytes."
    )
    return compressed
  }

  private fun compressImage(bytes: ByteArray, name: String): PreparedDocument? {
    val bounds = BitmapFactory.Options().apply {
      inJustDecodeBounds = true
    }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)

    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      return null
    }

    val sampleSize = calculateSampleSize(bounds.outWidth, bounds.outHeight)
    val decoded = BitmapFactory.decodeByteArray(
      bytes,
      0,
      bytes.size,
      BitmapFactory.Options().apply {
        inSampleSize = sampleSize
      }
    ) ?: return null

    val resized = resizeToLongSide(decoded, IMAGE_MAX_LONG_SIDE)
    if (resized !== decoded) {
      decoded.recycle()
    }

    val flattened = flattenOnWhite(resized)
    if (flattened !== resized) {
      resized.recycle()
    }

    val compressedBytes = compressWithQualityFloor(flattened)
    flattened.recycle()

    return PreparedDocument(
      bytes = compressedBytes,
      name = replaceExtensionWithJpeg(name),
      type = "image/jpeg",
      originalSize = bytes.size,
      compressed = true
    )
  }

  private fun calculateSampleSize(width: Int, height: Int): Int {
    var sampleSize = 1
    val longestSide = max(width, height)

    while (longestSide / sampleSize > IMAGE_MAX_LONG_SIDE * 2) {
      sampleSize *= 2
    }

    return sampleSize
  }

  private fun resizeToLongSide(bitmap: Bitmap, maxLongSide: Int): Bitmap {
    val longestSide = max(bitmap.width, bitmap.height)
    if (longestSide <= maxLongSide) {
      return bitmap
    }

    val scale = maxLongSide.toDouble() / longestSide.toDouble()
    val width = (bitmap.width * scale).roundToInt().coerceAtLeast(1)
    val height = (bitmap.height * scale).roundToInt().coerceAtLeast(1)
    return Bitmap.createScaledBitmap(bitmap, width, height, true)
  }

  private fun flattenOnWhite(bitmap: Bitmap): Bitmap {
    val flattened = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(flattened)
    canvas.drawColor(Color.WHITE)
    canvas.drawBitmap(bitmap, 0f, 0f, null)
    return flattened
  }

  private fun compressWithQualityFloor(bitmap: Bitmap): ByteArray {
    var best = ByteArray(0)

    for (quality in IMAGE_QUALITY_STEPS) {
      val output = ByteArrayOutputStream()
      bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)
      val candidate = output.toByteArray()
      best = candidate

      if (candidate.size <= IMAGE_TARGET_BYTES) {
        break
      }
    }

    return best
  }

  private fun replaceExtensionWithJpeg(name: String): String {
    val cleanName = name.substringAfterLast('/').ifBlank { "healz-document" }
    val baseName = cleanName.substringBeforeLast('.', cleanName)
    return "$baseName.jpg"
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
