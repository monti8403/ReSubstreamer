package com.resubstreamer.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule

class MusicWidgetActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "MusicWidgetActionReceiver"
        const val ACTION_PLAY_PAUSE = "com.resubstreamer.widget.ACTION_PLAY_PAUSE"
        const val ACTION_NEXT = "com.resubstreamer.widget.ACTION_NEXT"
        const val ACTION_PREV = "com.resubstreamer.widget.ACTION_PREV"
        const val ACTION_STAR = "com.resubstreamer.widget.ACTION_STAR"
        const val ACTION_SHUFFLE = "com.resubstreamer.widget.ACTION_SHUFFLE"
        const val ACTION_PLAY_RECENT = "com.resubstreamer.widget.ACTION_PLAY_RECENT"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        Log.d(TAG, "Received widget action: $action")

        val prefs = context.getSharedPreferences(MusicWidgetModule.PREFS_NAME, Context.MODE_PRIVATE)

        // Haptic feedback
        try {
            val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(30)
            }
        } catch (_: Exception) {}

        // Ensure MediaManager is initialized
        MusicWidgetMediaManager.initialize(context)

        val reactContext = MusicWidgetModule.reactContext
        val isJsActive = (reactContext != null && reactContext.hasActiveReactInstance())

        // Optimistic UI updates
        when (action) {
            ACTION_PLAY_PAUSE -> {
                if (MusicWidgetMediaManager.isConnected && MusicWidgetMediaManager.hasActiveMediaItem) {
                    val isCurrentlyPlaying = MusicWidgetMediaManager.isPlaying
                    val willPlay = !isCurrentlyPlaying
                    if (isCurrentlyPlaying) {
                        MusicWidgetMediaManager.pause(context)
                    } else {
                        MusicWidgetMediaManager.play(context)
                    }
                    prefs.edit()
                        .putBoolean("is_playing", willPlay)
                        .putBoolean("is_loading", false)
                        .putLong("loading_timestamp", 0L)
                        .apply()
                    MusicWidgetProvider.updateAllWidgets(context)
                    return
                }
                // Fallback for cold start / no media loaded: update UI and forward to JS
                val willPlay = !prefs.getBoolean("is_playing", false)
                prefs.edit()
                    .putBoolean("is_playing", willPlay)
                    .putBoolean("is_loading", false)
                    .putLong("loading_timestamp", 0L)
                    .apply()
                MusicWidgetProvider.updateAllWidgets(context)
            }
            ACTION_NEXT -> {
                prefs.edit().putBoolean("is_loading", false).putLong("loading_timestamp", 0L).apply()
                if (MusicWidgetMediaManager.isConnected && MusicWidgetMediaManager.hasActiveMediaItem) {
                    MusicWidgetMediaManager.skipToNext(context)
                    return
                }
            }
            ACTION_PREV -> {
                prefs.edit().putBoolean("is_loading", false).putLong("loading_timestamp", 0L).apply()
                if (MusicWidgetMediaManager.isConnected && MusicWidgetMediaManager.hasActiveMediaItem) {
                    MusicWidgetMediaManager.skipToPrevious(context)
                    return
                }
            }
            ACTION_STAR -> {
                val currentStarred = prefs.getBoolean("is_starred", false)
                prefs.edit().putBoolean("is_starred", !currentStarred).apply()
                MusicWidgetProvider.updateAllWidgets(context)
            }
            ACTION_SHUFFLE -> {
                // Do not force is_loading = true optimistically to avoid stuck spinner
            }
            ACTION_PLAY_RECENT -> {
                // Let true playback state govern loading, no artificial stuck spinner
            }
        }

        if (isJsActive && reactContext != null) {
            try {
                val params = Arguments.createMap().apply {
                    putString("action", action)
                    intent.getStringExtra("recent_id")?.let { putString("recentId", it) }
                    intent.getStringExtra("recent_type")?.let { putString("recentType", it) }
                    intent.getStringExtra("recent_title")?.let { putString("recentTitle", it) }
                }
                reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("onWidgetAction", params)
                return
            } catch (e: Exception) {
                Log.w(TAG, "Failed to emit widget action to ReactContext: ${e.message}")
            }
        }

        // React Native is backgrounded/cold -> launch HeadlessJsTaskService
        try {
            val serviceIntent = Intent(context, MusicWidgetTaskService::class.java).apply {
                putExtra("action", action)
                intent.getStringExtra("recent_id")?.let { putExtra("recentId", it) }
                intent.getStringExtra("recent_type")?.let { putExtra("recentType", it) }
                intent.getStringExtra("recent_title")?.let { putExtra("recentTitle", it) }
            }
            HeadlessJsTaskService.acquireWakeLockNow(context)
            context.startService(serviceIntent)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start HeadlessJsTaskService: ${e.message}", e)
        }
    }
}
