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
 */
object MusicWidgetMediaManager {

    private const val TAG = "MusicWidgetMediaMgr"
    private var controllerFuture: ListenableFuture<MediaController>? = null

    @Volatile
    var mediaController: MediaController? = null
        private set

    fun initialize(context: Context) {
        if (mediaController != null) return
        val appContext = context.applicationContext

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
                        Log.d(TAG, "MediaController successfully connected to PlaybackService")

                        controller.addListener(object : Player.Listener {
                            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                                Log.d(TAG, "onMediaItemTransition: title=${mediaItem?.mediaMetadata?.title}, reason=$reason")
                                syncFromController(appContext, controller)
                            }

                            override fun onIsPlayingChanged(isPlaying: Boolean) {
                                Log.d(TAG, "onIsPlayingChanged: isPlaying=$isPlaying")
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
                    }
                }, ContextCompat.getMainExecutor(appContext))
            } catch (e: Exception) {
                Log.w(TAG, "Failed to initialize SessionToken / MediaController: ${e.message}")
                controllerFuture = null
            }
        }
    }

    fun syncFromController(context: Context, controller: MediaController) {
        try {
            val mediaItem = controller.currentMediaItem
            val isPlaying = controller.isPlaying
            val prefs = context.getSharedPreferences(MusicWidgetModule.PREFS_NAME, Context.MODE_PRIVATE)
            val editor = prefs.edit()

            editor.putBoolean("is_playing", isPlaying)
            editor.putBoolean("is_loading", false)

            if (mediaItem != null) {
                val metadata = mediaItem.mediaMetadata
                val title = metadata.title?.toString()
                val artist = metadata.artist?.toString()
                val album = metadata.albumTitle?.toString()
                val artworkUri = metadata.artworkUri?.toString()
                val trackId = mediaItem.mediaId

                if (!title.isNullOrEmpty()) editor.putString("title", title)
                if (!artist.isNullOrEmpty()) editor.putString("artist", artist)
                if (!album.isNullOrEmpty()) editor.putString("album", album)
                if (!artworkUri.isNullOrEmpty()) editor.putString("cover_uri", artworkUri)
                if (!trackId.isNullOrEmpty()) editor.putString("track_id", trackId)
            }

            editor.apply()
            MusicWidgetProvider.updateAllWidgets(context)
        } catch (e: Exception) {
            Log.w(TAG, "syncFromController error: ${e.message}")
        }
    }

    fun play() {
        mediaController?.let { controller ->
            if (!controller.isPlaying) {
                controller.play()
            }
        }
    }

    fun pause() {
        mediaController?.let { controller ->
            if (controller.isPlaying) {
                controller.pause()
            }
        }
    }

    fun skipToNext() {
        mediaController?.let { controller ->
            if (controller.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)) {
                controller.seekToNextMediaItem()
            } else if (controller.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT)) {
                controller.seekToNext()
            }
        }
    }

    fun skipToPrevious() {
        mediaController?.let { controller ->
            if (controller.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)) {
                controller.seekToPreviousMediaItem()
            } else if (controller.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS)) {
                controller.seekToPrevious()
            }
        }
    }
}
