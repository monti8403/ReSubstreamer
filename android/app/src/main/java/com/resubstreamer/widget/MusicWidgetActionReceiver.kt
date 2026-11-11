package com.resubstreamer.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
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
        Log.d(TAG, "Received action: $action")

        val prefs = context.getSharedPreferences(MusicWidgetModule.PREFS_NAME, Context.MODE_PRIVATE)

        // Optimistic UI updates
        when (action) {
            ACTION_PLAY_PAUSE -> {
                val currentPlaying = prefs.getBoolean("is_playing", false)
                prefs.edit().putBoolean("is_playing", !currentPlaying).apply()
                MusicWidgetProvider.updateAllWidgets(context)
            }
            ACTION_STAR -> {
                val currentStarred = prefs.getBoolean("is_starred", false)
                prefs.edit().putBoolean("is_starred", !currentStarred).apply()
                MusicWidgetProvider.updateAllWidgets(context)
            }
        }

        val reactContext = MusicWidgetModule.reactContext
        if (reactContext != null && reactContext.hasActiveReactInstance()) {
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
