package com.resubstreamer.widget

import android.content.ComponentName
import android.content.Context
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture

/**
 * Native Android Media3 manager that maintains a direct MediaController connection
 * to PlaybackService (MediaLibraryService).
 *
 * This provides 100% native, zero-latency background synchronization:
 * - Real-time track changes (auto-advance) update the widget immediately without relying on JS.
 * - Play/Pause and playback state changes update the widget RemoteViews instantly.
 * - Transport controls (Next, Prev, Play, Pause) can be executed natively in milliseconds.
 *
 * Thread Safety:
 * MediaController methods (isPlaying, play, pause, etc.) must only be called on the application
 * main thread (Looper.getMainLooper()). Background threads (such as React Native modules) must read
 * the @Volatile state flags (isPlaying, hasActiveMediaItem, isConnected) to avoid IllegalStateException.
 */
object MusicWidgetMediaManager {

    private const val TAG = "MusicWidgetMediaMgr"
    private var controllerFuture: ListenableFuture<MediaController>? = null

    @Volatile
    private var applicationContext: Context? = null

    @Volatile
    var mediaController: MediaController? = null
        private set

    @Volatile
    var isPlaying: Boolean = false
        private set

    @Volatile
    var hasActiveMediaItem: Boolean = false
        private set

    @Volatile
    var isConnected: Boolean = false
        private set

    fun initialize(context: Context) {
        val appContext = context.applicationContext
        applicationContext = appContext
        if (mediaController != null) return

        ContextCompat.getMainExecutor(appContext).execute {
            if (mediaController != null || controllerFuture != null) return@execute

            try {
                val serviceComponent = ComponentName(
                    appContext,
                    "com.margelo.nitro.queueplayer.PlaybackService"
                )
                val sessionToken = SessionToken(appContext, serviceComponent)
                val future = MediaController.Builder(appContext, sessionToken).buildAsync()
                controllerFuture = future

                future.addListener({
                    try {
                        val controller = future.get()
                        mediaController = controller
                        isConnected = true
                        isPlaying = controller.isPlaying
                        hasActiveMediaItem = (controller.currentMediaItem != null)
                        Log.d(TAG, "MediaController successfully connected to PlaybackService")

                        controller.addListener(object : Player.Listener {
                            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                                hasActiveMediaItem = (mediaItem != null)
                                Log.d(TAG, "onMediaItemTransition: title=${mediaItem?.mediaMetadata?.title}, reason=$reason")
                                syncFromController(appContext, controller)
                            }

                            override fun onIsPlayingChanged(playing: Boolean) {
                                isPlaying = playing
                                Log.d(TAG, "onIsPlayingChanged: isPlaying=$playing")
                                syncFromController(appContext, controller)
                            }

                            override fun onPlaybackStateChanged(playbackState: Int) {
                                Log.d(TAG, "onPlaybackStateChanged: state=$playbackState")
                                syncFromController(appContext, controller)
                            }
                        })

                        syncFromController(appContext, controller)
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to connect MediaController: ${e.message}")
                        controllerFuture = null
                        isConnected = false
                    }
                }, ContextCompat.getMainExecutor(appContext))
            } catch (e: Exception) {
                Log.w(TAG, "Failed to initialize SessionToken / MediaController: ${e.message}")
                controllerFuture = null
                isConnected = false
            }
        }
    }

    fun syncFromController(context: Context, controller: MediaController) {
        try {
            val mediaItem = controller.currentMediaItem
            val playing = controller.isPlaying
            val playbackState = controller.playbackState

            isPlaying = playing
            hasActiveMediaItem = (mediaItem != null)

            val prefs = context.getSharedPreferences(MusicWidgetModule.PREFS_NAME, Context.MODE_PRIVATE)
            val editor = prefs.edit()

            val prevPlaying = prefs.getBoolean("is_playing", false)
            val prevLoading = prefs.getBoolean("is_loading", false)
            val prevTrackId = prefs.getString("track_id", null)

            // Never set loading = true on normal buffering to prevent stuck spinners during track skips
            val newLoading = if (playing || playbackState == Player.STATE_READY || playbackState == Player.STATE_ENDED) {
                false
            } else {
                prevLoading
            }

            var hasChange = (prevPlaying != playing) || (prevLoading != newLoading)
            editor.putBoolean("is_playing", playing)
            editor.putBoolean("is_loading", newLoading)
            if (!newLoading) {
                editor.putLong("loading_timestamp", 0L)
            }

            if (mediaItem != null) {
                val metadata = mediaItem.mediaMetadata
                val title = metadata.title?.toString()
                val artist = metadata.artist?.toString()
                val album = metadata.albumTitle?.toString()
                val artworkUri = metadata.artworkUri?.toString()
                val trackId = mediaItem.mediaId

                if (!title.isNullOrEmpty() && title != prefs.getString("title", null)) {
                    editor.putString("title", title)
                    hasChange = true
                }
                if (!artist.isNullOrEmpty() && artist != prefs.getString("artist", null)) {
                    editor.putString("artist", artist)
                    hasChange = true
                }
                if (!album.isNullOrEmpty()) editor.putString("album", album)
                if (!artworkUri.isNullOrEmpty() && artworkUri != prefs.getString("cover_uri", null)) {
                    editor.putString("cover_uri", artworkUri)
                    hasChange = true
                }
                if (!trackId.isNullOrEmpty() && trackId != prevTrackId) {
                    editor.putString("track_id", trackId)
                    hasChange = true
                }
            }

            editor.apply()
            if (hasChange) {
                MusicWidgetProvider.updateAllWidgets(context)
            }
        } catch (e: Exception) {
            Log.w(TAG, "syncFromController error: ${e.message}")
        }
    }

    fun play(context: Context? = null) {
        val ctx = context?.applicationContext ?: applicationContext ?: return
        ContextCompat.getMainExecutor(ctx).execute {
            try {
                mediaController?.let { controller ->
                    if (!controller.isPlaying) {
                        controller.play()
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "play error: ${e.message}")
            }
        }
    }

    fun pause(context: Context? = null) {
        val ctx = context?.applicationContext ?: applicationContext ?: return
        ContextCompat.getMainExecutor(ctx).execute {
            try {
                mediaController?.let { controller ->
                    if (controller.isPlaying) {
                        controller.pause()
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "pause error: ${e.message}")
            }
        }
    }

    fun skipToNext(context: Context? = null) {
        val ctx = context?.applicationContext ?: applicationContext ?: return
        ContextCompat.getMainExecutor(ctx).execute {
            try {
                mediaController?.let { controller ->
                    if (controller.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)) {
                        controller.seekToNextMediaItem()
                    } else if (controller.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT)) {
                        controller.seekToNext()
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "skipToNext error: ${e.message}")
            }
        }
    }

    fun skipToPrevious(context: Context? = null) {
        val ctx = context?.applicationContext ?: applicationContext ?: return
        ContextCompat.getMainExecutor(ctx).execute {
            try {
                mediaController?.let { controller ->
                    if (controller.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)) {
                        controller.seekToPreviousMediaItem()
                    } else if (controller.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS)) {
                        controller.seekToPrevious()
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "skipToPrevious error: ${e.message}")
            }
        }
    }
}
