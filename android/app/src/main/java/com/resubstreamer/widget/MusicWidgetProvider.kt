package com.resubstreamer.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.util.LruCache
import android.view.View
import android.widget.RemoteViews
import androidx.core.graphics.ColorUtils
import androidx.palette.graphics.Palette
import com.resubstreamer.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.io.File
import java.net.URL

class MusicWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle
    ) {
        super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions)
        updateWidget(context, appWidgetManager, appWidgetId)
    }

    companion object {
        private const val TAG = "MusicWidgetProvider"
        private val coroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

        data class CoverColorData(
            val mainRoundedBitmap: Bitmap?,
            val recentRoundedBitmap: Bitmap?,
            val circularBitmap: Bitmap?,
            val dominantColor: Int,
            val vibrantColor: Int
        )

        // Memory cache for decoded bitmaps and extracted palette colors (keyed by URI)
        private val coverCache = object : LruCache<String, CoverColorData>(20) {}

        fun updateAllWidgets(context: Context) {
            try {
                val appWidgetManager = AppWidgetManager.getInstance(context)
                val ids = appWidgetManager.getAppWidgetIds(ComponentName(context, MusicWidgetProvider::class.java))
                for (id in ids) {
                    updateWidget(context, appWidgetManager, id)
                }
            } catch (e: Exception) {
                Log.e(TAG, "updateAllWidgets error: ${e.message}", e)
            }
        }

        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            try {
                MusicWidgetMediaManager.initialize(context)

                val options = appWidgetManager.getAppWidgetOptions(appWidgetId)
                val minHeight = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0) ?: 0
                val maxHeight = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0) ?: 0

                // Size bucket:
                // 4x1 (1 row) has maxHeight ~110-125dp and minHeight ~70-85dp -> Compact (widget_compact)
                // 4x2 / 4x3 (2+ rows) have maxHeight >= 160dp or minHeight >= 120dp -> Expanded with recents (widget_expanded)
                val isExpanded = (maxHeight >= 160) || (minHeight >= 120)

                val layoutId = if (isExpanded) R.layout.widget_expanded else R.layout.widget_compact
                val views = RemoteViews(context.packageName, layoutId)

                val prefs = context.getSharedPreferences(MusicWidgetModule.PREFS_NAME, Context.MODE_PRIVATE)
                val title = prefs.getString("title", null)?.ifEmpty { null } ?: context.getString(R.string.widget_no_track)
                val artist = prefs.getString("artist", null)?.ifEmpty { null } ?: context.getString(R.string.widget_ready_to_play)
                val coverUri = prefs.getString("cover_uri", null)
                val controller = MusicWidgetMediaManager.mediaController
                val isPlaying = controller?.isPlaying ?: prefs.getBoolean("is_playing", false)
                val isStarred = prefs.getBoolean("is_starred", false)
                val isLoading = prefs.getBoolean("is_loading", false)
                val theme = prefs.getString("widget_theme", "dynamic") ?: "dynamic"
                val isOled = theme == "oled"
                val recentItemsJson = prefs.getString("recent_items", "[]") ?: "[]"

                // Text
                views.setTextViewText(R.id.widget_title, title)
                views.setTextViewText(R.id.widget_artist, artist)

                // Play/Pause / Loading spinner: auto-expire stale loading after 2.5s to prevent stuck spinner
                val loadingTime = prefs.getLong("loading_timestamp", 0L)
                val isStaleLoading = (loadingTime > 0L) && ((System.currentTimeMillis() - loadingTime) > 2500L)
                val showSpinner = isLoading && !isPlaying && !isStaleLoading

                if (showSpinner) {
                    views.setViewVisibility(R.id.btn_play_pause, View.GONE)
                    views.setViewVisibility(R.id.widget_loading_spinner, View.VISIBLE)
                } else {
                    views.setViewVisibility(R.id.widget_loading_spinner, View.GONE)
                    views.setViewVisibility(R.id.btn_play_pause, View.VISIBLE)
                    views.setImageViewResource(
                        R.id.btn_play_pause,
                        if (isPlaying) R.drawable.ic_widget_pause else R.drawable.ic_widget_play
                    )
                    // If loading was stale or we are playing, persist cleared loading state
                    if (isLoading && (!showSpinner || isPlaying)) {
                        prefs.edit().putBoolean("is_loading", false).putLong("loading_timestamp", 0L).apply()
                    }
                }

                // Star icon
                views.setImageViewResource(
                    R.id.btn_star,
                    if (isStarred) R.drawable.ic_widget_heart_filled else R.drawable.ic_widget_heart
                )

                // Shuffle icon
                views.setImageViewResource(R.id.btn_shuffle, R.drawable.ic_widget_shuffle)

                // Tap on Track Info / Cover -> open full player in app
                val openPlayerIntent = Intent(Intent.ACTION_VIEW, Uri.parse("resubstreamer://player")).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
                val openPlayerPendingIntent = PendingIntent.getActivity(
                    context,
                    100,
                    openPlayerIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                views.setOnClickPendingIntent(R.id.layout_track_info, openPlayerPendingIntent)
                views.setOnClickPendingIntent(R.id.widget_cover, openPlayerPendingIntent)

                // PendingIntents for Controls
                views.setOnClickPendingIntent(
                    R.id.btn_play_pause,
                    createBroadcastIntent(context, MusicWidgetActionReceiver.ACTION_PLAY_PAUSE, 101)
                )
                views.setOnClickPendingIntent(
                    R.id.container_play_pause,
                    createBroadcastIntent(context, MusicWidgetActionReceiver.ACTION_PLAY_PAUSE, 101)
                )
                views.setOnClickPendingIntent(
                    R.id.btn_next,
                    createBroadcastIntent(context, MusicWidgetActionReceiver.ACTION_NEXT, 102)
                )
                views.setOnClickPendingIntent(
                    R.id.btn_prev,
                    createBroadcastIntent(context, MusicWidgetActionReceiver.ACTION_PREV, 103)
                )
                views.setOnClickPendingIntent(
                    R.id.btn_star,
                    createBroadcastIntent(context, MusicWidgetActionReceiver.ACTION_STAR, 104)
                )
                views.setOnClickPendingIntent(
                    R.id.btn_shuffle,
                    createBroadcastIntent(context, MusicWidgetActionReceiver.ACTION_SHUFFLE, 105)
                )

                // Check cached cover data
                val cachedData = if (!coverUri.isNullOrEmpty()) coverCache.get(coverUri) else null
                val defaultDominant = if (isOled) Color.BLACK else Color.parseColor("#181818")
                val defaultVibrant = if (isOled) Color.parseColor("#262626") else Color.parseColor("#333333")
                val activeData = cachedData ?: CoverColorData(null, null, null, defaultDominant, defaultVibrant)

                // Apply cover & zero-bitmap tint theme
                applyCoverAndTheme(context, views, activeData, isOled)

                // Populate Recents if expanded
                if (isExpanded) {
                    populateRecentCards(context, views, recentItemsJson, appWidgetId)
                }

                // Render views immediately
                appWidgetManager.updateAppWidget(appWidgetId, views)

                // Collect missing covers (main cover and recent items)
                val missingUris = mutableListOf<String>()
                if (!coverUri.isNullOrEmpty() && coverCache.get(coverUri) == null) {
                    missingUris.add(coverUri)
                }
                if (isExpanded) {
                    try {
                        val array = JSONArray(recentItemsJson)
                        for (i in 0 until minOf(4, array.length())) {
                            val uri = array.getJSONObject(i).optString("coverUri", "")
                            if (uri.isNotEmpty() && coverCache.get(uri) == null && !missingUris.contains(uri)) {
                                missingUris.add(uri)
                            }
                        }
                    } catch (_: Exception) {}
                }

                if (missingUris.isNotEmpty()) {
                    coroutineScope.launch {
                        withContext(Dispatchers.IO) {
                            for (uri in missingUris) {
                                val loaded = loadCoverAndExtractColors(context, uri)
                                if (loaded != null) {
                                    coverCache.put(uri, loaded)
                                }
                            }
                        }
                        withContext(Dispatchers.Main) {
                            updateWidget(context, appWidgetManager, appWidgetId)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "updateWidget error for widgetId $appWidgetId: ${e.message}", e)
            }
        }

        private fun createBroadcastIntent(context: Context, action: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, MusicWidgetActionReceiver::class.java).apply {
                this.action = action
            }
            return PendingIntent.getBroadcast(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun populateRecentCards(context: Context, views: RemoteViews, recentItemsJson: String, appWidgetId: Int) {
            val cardIds = intArrayOf(R.id.card_recent_1, R.id.card_recent_2, R.id.card_recent_3, R.id.card_recent_4)
            val titleIds = intArrayOf(R.id.recent_title_1, R.id.recent_title_2, R.id.recent_title_3, R.id.recent_title_4)
            val coverIds = intArrayOf(R.id.recent_cover_1, R.id.recent_cover_2, R.id.recent_cover_3, R.id.recent_cover_4)

            try {
                val array = JSONArray(recentItemsJson)
                for (i in 0 until 4) {
                    if (i < array.length()) {
                        val obj = array.getJSONObject(i)
                        val id = obj.optString("id", "")
                        val type = obj.optString("type", "album")
                        val title = obj.optString("title", "")
                        val coverUri = obj.optString("coverUri", "")

                        views.setViewVisibility(cardIds[i], View.VISIBLE)
                        views.setTextViewText(titleIds[i], title)

                        // Set default cover initially or cached
                        val cached = if (coverUri.isNotEmpty()) coverCache.get(coverUri) else null
                        if (cached != null) {
                            val bmp = if (type == "artist") cached.circularBitmap else (cached.recentRoundedBitmap ?: cached.mainRoundedBitmap)
                            if (bmp != null) {
                                views.setImageViewBitmap(coverIds[i], bmp)
                            } else {
                                views.setImageViewResource(coverIds[i], R.drawable.ic_widget_default_cover)
                            }
                        } else {
                            views.setImageViewResource(coverIds[i], R.drawable.ic_widget_default_cover)
                        }

                        // PendingIntent to play this recent item with unique Data URI
                        val playIntent = Intent(context, MusicWidgetActionReceiver::class.java).apply {
                            action = MusicWidgetActionReceiver.ACTION_PLAY_RECENT
                            data = Uri.parse("resubstreamer://widget/recent/$i/$id")
                            putExtra("recent_id", id)
                            putExtra("recent_type", type)
                            putExtra("recent_title", title)
                        }
                        val pending = PendingIntent.getBroadcast(
                            context,
                            200 + i,
                            playIntent,
                            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                        )
                        views.setOnClickPendingIntent(cardIds[i], pending)
                        views.setOnClickPendingIntent(coverIds[i], pending)
                        views.setOnClickPendingIntent(titleIds[i], pending)
                    } else {
                        views.setViewVisibility(cardIds[i], View.GONE)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Error populating recent cards: ${e.message}")
            }
        }

        private fun applyCoverAndTheme(
            context: Context,
            views: RemoteViews,
            data: CoverColorData,
            isOled: Boolean
        ) {
            // 1. Cover
            if (data.mainRoundedBitmap != null) {
                views.setImageViewBitmap(R.id.widget_cover, data.mainRoundedBitmap)
            } else {
                views.setImageViewResource(R.id.widget_cover, R.drawable.ic_widget_default_cover)
            }

            // 2. Play button circle background
            if (isOled) {
                // In OLED mode, keep play button sleek neutral dark without dynamic color jumps
                views.setInt(R.id.btn_play_bg, "setColorFilter", Color.parseColor("#262626"))
            } else {
                views.setInt(R.id.btn_play_bg, "setColorFilter", data.vibrantColor)
            }

            // 3. Widget Background: switch between dedicated OLED and Dynamic ImageViews
            if (isOled) {
                views.setViewVisibility(R.id.widget_bg_oled, View.VISIBLE)
                views.setViewVisibility(R.id.widget_bg_dynamic, View.GONE)
            } else {
                views.setViewVisibility(R.id.widget_bg_oled, View.GONE)
                views.setViewVisibility(R.id.widget_bg_dynamic, View.VISIBLE)
                val darkenedDominant = ColorUtils.blendARGB(data.dominantColor, Color.BLACK, 0.75f)
                views.setInt(R.id.widget_bg_dynamic, "setColorFilter", darkenedDominant)
            }
        }

        private suspend fun loadCoverAndExtractColors(context: Context, coverUri: String): CoverColorData? {
            return withContext(Dispatchers.IO) {
                try {
                    val rawBitmap = when {
                        coverUri.startsWith("content://") -> {
                            try {
                                context.contentResolver.openInputStream(Uri.parse(coverUri))?.use {
                                    BitmapFactory.decodeStream(it)
                                }
                            } catch (e: Exception) {
                                Log.w(TAG, "Failed reading content URI $coverUri: ${e.message}")
                                null
                            }
                        }
                        coverUri.startsWith("file://") -> {
                            val path = Uri.parse(coverUri).path
                            if (path != null && File(path).exists()) BitmapFactory.decodeFile(path) else null
                        }
                        coverUri.startsWith("/") -> {
                            if (File(coverUri).exists()) BitmapFactory.decodeFile(coverUri) else null
                        }
                        coverUri.startsWith("http://") || coverUri.startsWith("https://") -> {
                            try {
                                val conn = URL(coverUri).openConnection() as java.net.HttpURLConnection
                                conn.connectTimeout = 5000
                                conn.readTimeout = 5000
                                conn.instanceFollowRedirects = true
                                conn.inputStream.use { BitmapFactory.decodeStream(it) }
                            } catch (e: Exception) {
                                Log.w(TAG, "Failed loading cover from URL $coverUri: ${e.message}")
                                null
                            }
                        }
                        else -> null
                    } ?: return@withContext null

                    // Palette extraction from original rawBitmap
                    val palette = Palette.from(rawBitmap).generate()
                    val vibrant = palette.vibrantSwatch?.rgb
                        ?: palette.dominantSwatch?.rgb
                        ?: Color.parseColor("#1DB954")
                    val dominant = palette.dominantSwatch?.rgb
                        ?: palette.darkMutedSwatch?.rgb
                        ?: Color.parseColor("#181818")

                    // Strictly downscale bitmaps to avoid TransactionTooLargeException
                    val density = context.resources.displayMetrics.density
                    val targetMainPx = (52 * density).toInt().coerceIn(104, 180)
                    val targetRecentPx = (54 * density).toInt().coerceIn(108, 180)

                    val mainRounded = getRoundedCornerBitmap(rawBitmap, 10f, targetMainPx, context)
                    val recentRounded = getRoundedCornerBitmap(rawBitmap, 8f, targetRecentPx, context)
                    val circular = getCircularBitmap(rawBitmap, targetRecentPx)

                    CoverColorData(
                        mainRoundedBitmap = mainRounded,
                        recentRoundedBitmap = recentRounded,
                        circularBitmap = circular,
                        dominantColor = dominant,
                        vibrantColor = vibrant
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to load cover from $coverUri: ${e.message}")
                    null
                }
            }
        }

        private fun getRoundedCornerBitmap(bitmap: Bitmap, cornerRadiusDp: Float, targetSizePx: Int, context: Context): Bitmap {
            val density = context.resources.displayMetrics.density
            val radiusPx = cornerRadiusDp * density
            val output = Bitmap.createBitmap(targetSizePx, targetSizePx, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(output)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val rect = RectF(0f, 0f, targetSizePx.toFloat(), targetSizePx.toFloat())

            canvas.drawRoundRect(rect, radiusPx, radiusPx, paint)
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)

            val minOrig = Math.min(bitmap.width, bitmap.height)
            val srcRect = Rect(
                (bitmap.width - minOrig) / 2,
                (bitmap.height - minOrig) / 2,
                (bitmap.width + minOrig) / 2,
                (bitmap.height + minOrig) / 2
            )
            val destRect = Rect(0, 0, targetSizePx, targetSizePx)
            canvas.drawBitmap(bitmap, srcRect, destRect, paint)
            return output
        }

        private fun getCircularBitmap(bitmap: Bitmap, targetSizePx: Int): Bitmap {
            val output = Bitmap.createBitmap(targetSizePx, targetSizePx, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(output)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val radius = targetSizePx / 2f

            canvas.drawCircle(radius, radius, radius, paint)
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)

            val minOrig = Math.min(bitmap.width, bitmap.height)
            val srcRect = Rect(
                (bitmap.width - minOrig) / 2,
                (bitmap.height - minOrig) / 2,
                (bitmap.width + minOrig) / 2,
                (bitmap.height + minOrig) / 2
            )
            val destRect = Rect(0, 0, targetSizePx, targetSizePx)
            canvas.drawBitmap(bitmap, srcRect, destRect, paint)
            return output
        }
    }
}
