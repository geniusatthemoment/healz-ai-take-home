package ai.healz.mobile

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ViewManager
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID
import java.util.WeakHashMap
import org.json.JSONArray
import kotlin.math.max
import kotlin.math.roundToInt

private const val MAX_SHARED_FILE_BYTES = 12 * 1024 * 1024
private const val MAX_SHARED_BATCH_FILES = 5
private const val MAX_SHARED_BATCH_BYTES = 20 * 1024 * 1024
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
  private const val PREFS_NAME = "healz_shared_documents"
  private const val PREF_ACTION = "action"
  private const val PREF_TYPE = "type"
  private const val PREF_URIS = "uris"
  private const val PREF_URIS_JSON = "uris_json"
  private const val CACHE_DIRECTORY = "shared-documents"
  private var pendingIntent: Intent? = null

  fun capture(context: Context, intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND && intent?.action != Intent.ACTION_SEND_MULTIPLE) {
      return
    }

    val uris = extractUris(intent)
    if (uris.isEmpty()) {
      return
    }

    // Google Photos and some mail clients give us a one-shot content URI. A
    // restart can invalidate it before React Native asks for the file, so copy
    // it into app-private cache while this Activity still has the grant.
    val cachedUris = uris.map { uri -> cacheSharedUri(context, uri) }
    val cachedIntent = Intent(intent).apply {
      if (action == Intent.ACTION_SEND) {
        putExtra(Intent.EXTRA_STREAM, cachedUris.first())
      } else {
        putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(cachedUris))
      }
    }
    pendingIntent = cachedIntent
    val uriArray = JSONArray()
    cachedUris.forEach { uri ->
      uriArray.put(uri.toString())
    }

    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
      .putString(PREF_ACTION, intent.action)
      .putString(PREF_TYPE, intent.type)
      // StringSet does not preserve order. JSON keeps multi-file shares
      // deterministic and remains readable after process death.
      .putString(PREF_URIS_JSON, uriArray.toString())
      // The first share may cold-start the process. Commit this tiny record
      // before React Native initializes so the intent cannot be lost.
      .commit()
  }

  fun clear(context: Context) {
    pendingIntent = null
    sharedCacheDirectory(context).deleteRecursively()
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .clear()
      .apply()
  }

  fun readFirstSharedDocument(context: Context): WritableMap? {
    val intent = pendingIntent ?: restoreIntent(context) ?: return null
    val uris = extractUris(intent)
    if (uris.isEmpty()) {
      return null
    }

    require(uris.size <= MAX_SHARED_BATCH_FILES) {
      "You can share up to $MAX_SHARED_BATCH_FILES files at once."
    }

    Log.i("SharedDocument", "Received ${uris.size} shared URI(s).")
    val documents = Arguments.createArray()
    var totalOriginalSize = 0L
    var totalPreparedSize = 0L
    var compressedCount = 0

    uris.forEach { uri ->
      val document = readSharedDocument(context, intent, uri)
      require(totalOriginalSize + document.originalSize.toLong() <= MAX_SHARED_BATCH_BYTES) {
        "The shared files are larger than 20 MB in total. Please share fewer or smaller files."
      }
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

  private fun restoreIntent(context: Context): Intent? {
    val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val action = preferences.getString(PREF_ACTION, null) ?: return null
    val savedJson = preferences.getString(PREF_URIS_JSON, null)
    val uris = if (!savedJson.isNullOrBlank()) {
      runCatching {
        val array = JSONArray(savedJson)
        (0 until array.length()).map { Uri.parse(array.getString(it)) }
      }.getOrDefault(emptyList())
    } else emptyList()
    if (uris.isEmpty()) {
      return null
    }

    return Intent(action).apply {
      type = preferences.getString(PREF_TYPE, null)
      if (action == Intent.ACTION_SEND) {
        putExtra(Intent.EXTRA_STREAM, uris.first())
      } else {
        putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
      }
    }.also { pendingIntent = it }
  }

  private fun readSharedDocument(
    context: Context,
    intent: Intent,
    uri: Uri
  ): SharedDocumentPayload {
    val resolver = context.contentResolver
    val declaredMimeType = resolver.getType(uri) ?: intent.type ?: "application/octet-stream"

    val originalBytes = readBytes(resolver, uri)
    val mimeType = detectMimeType(originalBytes, declaredMimeType)

    if (!mimeType.startsWith("image/") && mimeType != "application/pdf") {
      throw IllegalArgumentException("Only PDF and image files are supported.")
    }

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
    if (uri.scheme == "file") {
      val file = File(requireNotNull(uri.path) { "Shared file path is missing." })
      require(file.exists()) { "The shared file is no longer available." }
      require(file.length() <= MAX_SHARED_FILE_BYTES) {
        "File is larger than 12 MB. Please choose a smaller file."
      }
      return FileInputStream(file).use { input -> readStream(input) }
    }
    val declaredSize = runCatching {
      resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
      }
    }.getOrNull()
    if (declaredSize != null) {
      require(declaredSize in 0..MAX_SHARED_FILE_BYTES.toLong()) {
        "File is larger than 12 MB. Please choose a smaller file."
      }
    }

    return resolver.openInputStream(uri).use { input ->
      requireNotNull(input) { "Could not open shared file." }
      readStream(input)
    }
  }

  private fun readStream(input: java.io.InputStream): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var total = 0L
    var emptyReads = 0
    while (true) {
      val read = input.read(buffer)
      if (read == -1) break
      if (read == 0) {
        emptyReads += 1
        if (emptyReads > 8) throw IllegalArgumentException("The file provider stopped returning data.")
        continue
      }
      emptyReads = 0
      total += read
      if (total > MAX_SHARED_FILE_BYTES.toLong()) {
        throw IllegalArgumentException("File is larger than 12 MB. Please choose a smaller file.")
      }
      output.write(buffer, 0, read)
    }
    return output.toByteArray()
  }

  private fun cacheSharedUri(context: Context, uri: Uri): Uri {
    val resolver = context.contentResolver
    val originalName = readMetadata(resolver, uri).first ?: "healz-document"
    val safeName = originalName.replace(Regex("[^A-Za-z0-9._-]"), "_").takeLast(96)
      .ifBlank { "healz-document" }
    val directory = sharedCacheDirectory(context).apply { mkdirs() }
    val target = File(directory, "${UUID.randomUUID()}_$safeName")

    try {
      resolver.openInputStream(uri).use { input ->
        requireNotNull(input) { "Could not open shared file." }
        FileOutputStream(target).use { output ->
          val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
          var total = 0L
          while (true) {
            val read = input.read(buffer)
            if (read == -1) break
            if (read == 0) continue
            total += read
            if (total > MAX_SHARED_FILE_BYTES.toLong()) {
              throw IllegalArgumentException("File is larger than 12 MB. Please choose a smaller file.")
            }
            output.write(buffer, 0, read)
          }
        }
      }
      return Uri.fromFile(target)
    } catch (error: Exception) {
      target.delete()
      throw error
    }
  }

  private fun sharedCacheDirectory(context: Context): File = File(context.cacheDir, CACHE_DIRECTORY)

  private fun prepareDocument(
    bytes: ByteArray,
    name: String,
    mimeType: String
  ): PreparedDocument {
    if (mimeType == "application/pdf") {
      require(hasPdfSignature(bytes)) {
        "This file is not a valid PDF document."
      }

      // PDFs are intentionally passed through byte-for-byte. Re-rendering a
      // medical PDF can remove text layers, annotations, or embedded scans.
      Log.i("SharedDocument", "Keeping PDF unchanged (${bytes.size} bytes).")
      return PreparedDocument(bytes, name, mimeType, bytes.size, compressed = false)
    }

    if (!mimeType.startsWith("image/")) {
      return PreparedDocument(bytes, name, mimeType, bytes.size, compressed = false)
    }

    // Validate even small images. Passing a mislabeled or truncated URI
    // through is a common cause of a later "failed to load file" message.
    if (!isDecodableImage(bytes)) {
      throw IllegalArgumentException("This image is damaged or not supported.")
    }

    if (bytes.size <= IMAGE_COMPRESSION_THRESHOLD_BYTES) {
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

    val oriented = applyExifOrientation(decoded, bytes)
    if (oriented !== decoded) {
      decoded.recycle()
    }

    val resized = resizeToLongSide(oriented, IMAGE_MAX_LONG_SIDE)
    if (resized !== oriented) {
      oriented.recycle()
    }

    val flattened = flattenOnWhite(resized)
    if (flattened !== resized) {
      resized.recycle()
    }

    val compressedBytes = compressWithQualityFloor(flattened)
    flattened.recycle()

    if (compressedBytes.isEmpty()) {
      return null
    }

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

  private fun isDecodableImage(bytes: ByteArray): Boolean {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return false

    return BitmapFactory.decodeByteArray(
      bytes,
      0,
      bytes.size,
      BitmapFactory.Options().apply { inSampleSize = calculateSampleSize(bounds.outWidth, bounds.outHeight) }
    )?.also { it.recycle() } != null
  }

  private fun detectMimeType(bytes: ByteArray, declaredMimeType: String): String {
    return when {
      hasPdfSignature(bytes) -> "application/pdf"
      hasBytes(bytes, byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte())) -> "image/jpeg"
      hasBytes(bytes, byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) -> "image/png"
      hasBytes(bytes, byteArrayOf(0x47, 0x49, 0x46, 0x38)) -> "image/gif"
      bytes.size >= 12 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" &&
        String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
      declaredMimeType.startsWith("image/") -> declaredMimeType
      else -> declaredMimeType
    }
  }

  private fun hasPdfSignature(bytes: ByteArray): Boolean {
    val scanLength = minOf(bytes.size, 1024)
    return scanLength >= 5 && String(bytes, 0, scanLength, Charsets.US_ASCII).contains("%PDF-")
  }

  private fun hasBytes(bytes: ByteArray, signature: ByteArray): Boolean {
    return bytes.size >= signature.size && bytes.copyOfRange(0, signature.size).contentEquals(signature)
  }

  private fun applyExifOrientation(bitmap: Bitmap, bytes: ByteArray): Bitmap {
    val orientation = runCatching {
      ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(
        ExifInterface.TAG_ORIENTATION,
        ExifInterface.ORIENTATION_NORMAL
      )
    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)

    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> {
        matrix.setRotate(90f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> {
        matrix.setRotate(-90f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
      else -> return bitmap
    }

    return runCatching {
      Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }.getOrElse {
      Log.w("SharedDocument", "Could not apply EXIF orientation; keeping decoded pixels.", it)
      bitmap
    }
  }

  private fun replaceExtensionWithJpeg(name: String): String {
    val cleanName = name.substringAfterLast('/').ifBlank { "healz-document" }
    val baseName = cleanName.substringBeforeLast('.', cleanName)
    return "$baseName.jpg"
  }

  private fun readMetadata(resolver: ContentResolver, uri: Uri): Pair<String?, Long?> {
    if (uri.scheme == "file") {
      val file = File(requireNotNull(uri.path) { "Shared file path is missing." })
      return Pair(file.name.substringAfter('_', file.name), file.length())
    }
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
  private val hookedWebViews = WeakHashMap<WebView, Boolean>()

  override fun getName(): String = "SharedDocument"

  @ReactMethod
  fun installWebViewRedrawHooks() {
    val activity = reactContext.currentActivity ?: return
    activity.runOnUiThread {
      val install: () -> Unit = {
        val installedHooks = installWebViewRedrawHooks(activity.window.decorView)
        Log.d("SharedDocument", "Installed redraw hooks on $installedHooks WebView(s).")
      }

      install()
    }
  }

  @ReactMethod
  fun invalidateWebView() {
    val activity = reactContext.currentActivity ?: return
    activity.runOnUiThread {
      val redraw: () -> Unit = {
        val invalidatedViews = invalidateWebViews(activity.window.decorView)
        Log.d("SharedDocument", "Requested redraw for $invalidatedViews WebView(s).")
      }

      redraw()
    }
  }

  @ReactMethod
  fun rebuildWebViewLayer() {
    val activity = reactContext.currentActivity ?: return
    activity.runOnUiThread {
      forEachWebView(activity.window.decorView) { webView ->
        // Keep WebView on its default accelerated surface. A one-pixel scroll
        // below is enough to make Chromium repaint stale tiles without
        // creating a separate explicit hardware layer.
        webView.setLayerType(View.LAYER_TYPE_NONE, null)
        webView.postDelayed({
          if (!webView.isAttachedToWindow) return@postDelayed
          webView.requestLayout()
          webView.invalidate()
          webView.postInvalidateOnAnimation()
        }, 16L)
      }
    }
  }

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
    SharedDocumentStore.clear(reactContext)
  }

  private fun installWebViewRedrawHooks(view: View): Int {
    var installedHooks = 0

    if (view is WebView && !hookedWebViews.containsKey(view)) {
      view.addOnLayoutChangeListener { changedView, _, _, _, _, _, _, _, _ ->
        changedView.invalidate()
        changedView.postInvalidateOnAnimation()
      }
      hookedWebViews[view] = true
      installedHooks += 1
    }

    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        installedHooks += installWebViewRedrawHooks(view.getChildAt(index))
      }
    }

    return installedHooks
  }

  private fun invalidateWebViews(view: View): Int {
    var invalidatedViews = 0

    if (view is WebView) {
      view.invalidate()
      view.postInvalidateOnAnimation()
      invalidatedViews += 1
    }

    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        invalidatedViews += invalidateWebViews(view.getChildAt(index))
      }
    }

    return invalidatedViews
  }

  private fun forEachWebView(view: View, action: (WebView) -> Unit) {
    if (view is WebView) {
      action(view)
    }

    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        forEachWebView(view.getChildAt(index), action)
      }
    }
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
