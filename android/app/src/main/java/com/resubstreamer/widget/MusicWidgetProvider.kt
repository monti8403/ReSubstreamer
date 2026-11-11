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
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.LruCache
import android.util.SizeF
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
            val roundedBitmap: Bitmap?,
            val circularBitmap: Bitmap?,
            val dominantColor: Int,
            val vibrantColor: Int
        )

        // Memory cache for decoded bitmaps and extracted palette colors (keyed by URI)
        private val coverCache = object : LruCache<String, CoverColorData>(20) {}

        fun updateAllWidgets(context: Context) {
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val ids = appWidgetManager.getAppWidgetIds(ComponentName(context, MusicWidgetProvider::class.java))
            for (id in ids) {
                updateWidget(context, appWidgetManager, id)
            }
        }

        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            MusicWidgetMediaManager.initialize(context)

            val prefs = context.getSharedPreferences(MusicWidgetModule.PREFS_NAME, Context.MODE_PRIVATE)
            val coverUri = prefs.getString("cover_uri", null)
            val theme = prefs.getString("widget_theme", "dynamic") ?: "dynamic"
            val isOled = theme == "oled"

            val cachedData = if (!coverUri.isNullOrEmpty()) coverCache.get(coverUri) else null
            val defaultDominant = if (isOled) Color.BLACK else Color.parseColor("#181818")
            val defaultVibrant = Color.parseColor("#1DB954")
            val activeData = cachedData ?: CoverColorData(null, null, defaultDominant, defaultVibrant)

            val options = appWidgetManager.getAppWidgetOptions(appWidgetId)
            val minHeight = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0) ?: 0
            val maxHeight = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0) ?: 0

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val compact = buildViewsForLayout(context, isExpanded = false, activeData, isOled)
                val expanded = buildViewsForLayout(context, isExpanded = true, activeData, isOled)
                val viewMapping = mapOf(
                    SizeF(180f, 40f) to compact,
                    SizeF(180f, 95f) to expanded
                )
                appWidgetManager.updateAppWidget(appWidgetId, RemoteViews(viewMapping))
            } else {
                val isExpanded = minHeight >= 95 || maxHeight >= 105
                val views = buildViewsForLayout(context, isExpanded, activeData, isOled)
                appWidgetManager.updateAppWidget(appWidgetId, views)
            }

            // If cover is not yet cached, fetch and process in background coroutine
            if (cachedData == null && !coverUri.isNullOrEmpty()) {
                coroutineScope.launch {
                    val loadedData = loadCoverAndExtractColors(context, coverUri)
                    if (loadedData != null) {
                        coverCache.put(coverUri, loadedData)
                        withContext(Dispatchers.Main) {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                                val compact = buildViewsForLayout(context, isExpanded = false, loadedData, isOled)
                                val expanded = buildViewsForLayout(context, isExpanded = true, loadedData, isOled)
                                val viewMapping = mapOf(
                                    SizeF(180f, 40f) to compact,
                                    SizeF(180f, 95f) to expanded
                                )
                                appWidgetManager.updateAppWidget(appWidgetId, RemoteViews(viewMapping))
                            } else {
                                val isExpanded = minHeight >= 95 || maxHeight >= 105
                                val views = buildViewsForLayout(context, isExpanded, loadedData, isOled)
                                appWidgetManager.updateAppWidget(appWidgetId, views)
                            }
                        }
                    }
                }
            }
        }

        private fun buildViewsForLayout(
            context: Context,
            isExpanded: Boolean,
            data: CoverColorData,
            isOled: Boolean
        ): RemoteViews {
            val layoutId = if (isExpanded) R.layout.widget_expanded else R.layout.widget_compact
            val views = RemoteViews(context.packageName, layoutId)

            val prefs = context.getSharedPreferences(MusicWidgetModule.PREFS_NAME, Context.MODE_PRIVATE)
            val title = prefs.getString("title", null)?.ifEmpty { null } ?: context.getString(R.string.widget_no_track)
            val artist = prefs.getString("artist", null)?.ifEmpty { null } ?: context.getString(R.string.widget_ready_to_play)
            val isPlaying = prefs.getBoolean("is_playing", false)
            val isStarred = prefs.getBoolean("is_starred", false)
            val isLoading = prefs.getBoolean("is_loading", false)
            val recentItemsJson = prefs.getString("recent_items", "[]") ?: "[]"

            // Text
            views.setTextViewText(R.id.widget_title, title)
            views.setTextViewText(R.id.widget_artist, artist)

            // Play/Pause / Loading spinner
            if (isLoading) {
                views.setViewVisibility(R.id.btn_play_pause, View.GONE)
                views.setViewVisibility(R.id.widget_loading_spinner, View.VISIBLE)
            } else {
                views.setViewVisibility(R.id.widget_loading_spinner, View.GONE)
                views.setViewVisibility(R.id.btn_play_pause, View.VISIBLE)
                views.setImageViewResource(
                    R.id.btn_play_pause,
                    if (isPlaying) R.drawable.ic_widget_pause else R.drawable.ic_widget_play
                )
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

            // Populate Recents if expanded
            if (isExpanded) {
                populateRecentCards(context, views, recentItemsJson)
            }

            // Apply artwork & theme colors
            applyCoverAndTheme(context, views, data, isOled, isExpanded)

            return views
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

        private fun populateRecentCards(context: Context, views: RemoteViews, recentItemsJson: String) {
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

                        // Set default cover initially
                        views.setImageViewResource(coverIds[i], R.drawable.ic_widget_default_cover)

                        // Load card cover if cached
                        if (coverUri.isNotEmpty()) {
                            val cached = coverCache.get(coverUri)
                            if (cached != null) {
                                val bmp = if (type == "artist") cached.circularBitmap else cached.roundedBitmap
                                if (bmp != null) views.setImageViewBitmap(coverIds[i], bmp)
                            } else {
                                coroutineScope.launch {
                                    val loaded = loadCoverAndExtractColors(context, coverUri)
                                    if (loaded != null) {
                                        coverCache.put(coverUri, loaded)
                                        withContext(Dispatchers.Main) {
                                            val bmp = if (type == "artist") loaded.circularBitmap else loaded.roundedBitmap
                                            if (bmp != null) {
                                                views.setImageViewBitmap(coverIds[i], bmp)
                                                AppWidgetManager.getInstance(context).updateAppWidget(
                                                    ComponentName(context, MusicWidgetProvider::class.java),
                                                    views
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // PendingIntent to play this recent item
                        val playIntent = Intent(context, MusicWidgetActionReceiver::class.java).apply {
                            action = MusicWidgetActionReceiver.ACTION_PLAY_RECENT
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
                    } else {
                        views.setViewVisibility(cardIds[i], View.INVISIBLE)
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
            isOled: Boolean,
            isExpanded: Boolean
        ) {
            // 1. Cover
            if (data.roundedBitmap != null) {
                views.setImageViewBitmap(R.id.widget_cover, data.roundedBitmap)
            } else {
                views.setImageViewResource(R.id.widget_cover, R.drawable.ic_widget_default_cover)
            }

            // 2. Play button circle background
            val playBgBmp = createColoredCircleBitmap(38f, data.vibrantColor, context)
            views.setImageViewBitmap(R.id.btn_play_bg, playBgBmp)

            // 3. Widget Background Bitmap
            val density = context.resources.displayMetrics.density
            val widthPx = (320 * density).toInt()
            val heightPx = if (isExpanded) (125 * density).toInt() else (70 * density).toInt()

            val bgBitmap = createWidgetBackgroundBitmap(
                widthPx = widthPx,
                heightPx = heightPx,
                cornerRadiusDp = 20f,
                context = context,
                isOled = isOled,
                dominantColor = data.dominantColor
            )
            views.setImageViewBitmap(R.id.widget_bg_image, bgBitmap)
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
                            val stream = URL(coverUri).openStream()
                            BitmapFactory.decodeStream(stream)
                        }
                        else -> null
                    } ?: return@withContext null

                    // Palette extraction
                    val palette = Palette.from(rawBitmap).generate()
                    val vibrant = palette.vibrantSwatch?.rgb
                        ?: palette.dominantSwatch?.rgb
                        ?: Color.parseColor("#1DB954")
                    val dominant = palette.dominantSwatch?.rgb
                        ?: palette.darkMutedSwatch?.rgb
                        ?: Color.parseColor("#181818")

                    val rounded = getRoundedCornerBitmap(rawBitmap, 10f, context)
                    val circular = getCircularBitmap(rawBitmap)

                    CoverColorData(
                        roundedBitmap = rounded,
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

        private fun getRoundedCornerBitmap(bitmap: Bitmap, cornerRadiusDp: Float, context: Context): Bitmap {
            val density = context.resources.displayMetrics.density
            val radiusPx = cornerRadiusDp * density
            val size = Math.min(bitmap.width, bitmap.height)
            val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(output)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val rect = RectF(0f, 0f, size.toFloat(), size.toFloat())

            canvas.drawRoundRect(rect, radiusPx, radiusPx, paint)
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)

            val srcRect = Rect(
                (bitmap.width - size) / 2,
                (bitmap.height - size) / 2,
                (bitmap.width + size) / 2,
                (bitmap.height + size) / 2
            )
            val destRect = Rect(0, 0, size, size)
            canvas.drawBitmap(bitmap, srcRect, destRect, paint)
            return output
        }

        private fun getCircularBitmap(bitmap: Bitmap): Bitmap {
            val size = Math.min(bitmap.width, bitmap.height)
            val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(output)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val radius = size / 2f

            canvas.drawCircle(radius, radius, radius, paint)
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)

            val srcRect = Rect(
                (bitmap.width - size) / 2,
                (bitmap.height - size) / 2,
                (bitmap.width + size) / 2,
                (bitmap.height + size) / 2
            )
            val destRect = Rect(0, 0, size, size)
            canvas.drawBitmap(bitmap, srcRect, destRect, paint)
            return output
        }

        private fun createColoredCircleBitmap(sizeDp: Float, color: Int, context: Context): Bitmap {
            val density = context.resources.displayMetrics.density
            val sizePx = (sizeDp * density).toInt()
            val output = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(output)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                this.color = color
                style = Paint.Style.FILL
            }
            val radius = sizePx / 2f
            canvas.drawCircle(radius, radius, radius, paint)
            return output
        }

        private fun createWidgetBackgroundBitmap(
            widthPx: Int,
            heightPx: Int,
            cornerRadiusDp: Float,
            context: Context,
            isOled: Boolean,
            dominantColor: Int
        ): Bitmap {
            val density = context.resources.displayMetrics.density
            val radiusPx = cornerRadiusDp * density
            val output = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(output)
            val rect = RectF(0f, 0f, widthPx.toFloat(), heightPx.toFloat())

            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            if (isOled) {
                // Pure OLED Black
                paint.color = Color.BLACK
                canvas.drawRoundRect(rect, radiusPx, radiusPx, paint)

                // Thin border
                val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.parseColor("#222222")
                    style = Paint.Style.STROKE
                    strokeWidth = 1.5f * density
                }
                val inset = 0.75f * density
                val strokeRect = RectF(inset, inset, widthPx.toFloat() - inset, heightPx.toFloat() - inset)
                canvas.drawRoundRect(strokeRect, radiusPx - inset, radiusPx - inset, strokePaint)
            } else {
                // Spotify style dynamic tinted gradient
                val darkenedDominant = ColorUtils.blendARGB(dominantColor, Color.BLACK, 0.72f)
                val baseDark = Color.parseColor("#121212")

                val shader = LinearGradient(
                    0f, 0f, 0f, heightPx.toFloat(),
                    intArrayOf(darkenedDominant, baseDark),
                    floatArrayOf(0f, 1f),
                    Shader.TileMode.CLAMP
                )
                paint.shader = shader
                canvas.drawRoundRect(rect, radiusPx, radiusPx, paint)

                // Subtle top highlight border
                val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = ColorUtils.setAlphaComponent(Color.WHITE, 25)
                    style = Paint.Style.STROKE
                    strokeWidth = 1f * density
                }
                val inset = 0.5f * density
                val strokeRect = RectF(inset, inset, widthPx.toFloat() - inset, heightPx.toFloat() - inset)
                canvas.drawRoundRect(strokeRect, radiusPx - inset, radiusPx - inset, strokePaint)
            }

            return output
        }
    }
}
