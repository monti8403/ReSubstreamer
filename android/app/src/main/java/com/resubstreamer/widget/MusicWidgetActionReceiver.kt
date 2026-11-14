package com.resubstreamer.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.atomic.AtomicBoolean

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
                val currentPlaying = if (MusicWidgetMediaManager.isConnected) {
                    MusicWidgetMediaManager.isPlaying
                } else {
                    prefs.getBoolean("is_playing", false)
                }
                val willPlay = !currentPlaying
                MusicWidgetMediaManager.setOptimisticPlaying(willPlay)
                prefs.edit()
                    .putBoolean("is_playing", willPlay)
                    .putBoolean("is_loading", false)
                    .putLong("loading_timestamp", 0L)
                    .apply()
                MusicWidgetProvider.updateAllWidgets(context)

                if (MusicWidgetMediaManager.isConnected && MusicWidgetMediaManager.hasActiveMediaItem) {
                    if (willPlay) {
                        MusicWidgetMediaManager.play(context)
                    } else {
                        MusicWidgetMediaManager.pause(context)
                    }
                    return
                }

                // Fallback for cold start / no media loaded: show spinner while JS loads queue
                if (willPlay) {
                    prefs.edit()
                        .putBoolean("is_loading", true)
                        .putLong("loading_timestamp", System.currentTimeMillis())
                        .apply()
                    MusicWidgetProvider.updateAllWidgets(context)
                }
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
                prefs.edit()
                    .putBoolean("is_loading", true)
                    .putLong("loading_timestamp", System.currentTimeMillis())
                    .apply()
                MusicWidgetProvider.updateAllWidgets(context)
            }
            ACTION_PLAY_RECENT -> {
                prefs.edit()
                    .putBoolean("is_loading", true)
                    .putLong("loading_timestamp", System.currentTimeMillis())
                    .apply()
                MusicWidgetProvider.updateAllWidgets(context)
            }
        }

        if (isJsActive && reactContext != null) {
            try {
                val params = Arguments.createMap().apply {
                    putString("action", action)
                    intent.getStringExtra("recent_id")?.let { putString("recentId", it) }
                    intent.getStringExtra("recent_type")?.let { putString("recentType", it) }
                    intent.getStringExtra("recent_title")?.let { putString("recentTitle", it) }
                    intent.getStringExtra("recent_subtitle")?.let { putString("recentSubtitle", it) }
                }
                reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("onWidgetAction", params)
                return
            } catch (e: Exception) {
                Log.w(TAG, "Failed to emit widget action to ReactContext: ${e.message}")
            }
        }

        // React Native is backgrounded/cold -> launch HeadlessJsTaskService without acquiring
        // the static WakeLock prematurely (which leaks forever if startService throws).
        val serviceIntent = Intent(context, MusicWidgetTaskService::class.java).apply {
            putExtra("action", action)
            intent.getStringExtra("recent_id")?.let { putExtra("recentId", it) }
            intent.getStringExtra("recent_type")?.let { putExtra("recentType", it) }
            intent.getStringExtra("recent_title")?.let { putExtra("recentTitle", it) }
            intent.getStringExtra("recent_subtitle")?.let { putExtra("recentSubtitle", it) }
        }

        try {
            val component = context.startService(serviceIntent)
            if (component != null) {
                HeadlessJsTaskService.acquireWakeLockNow(context)
                return
            }
            Log.w(TAG, "startService returned null for MusicWidgetTaskService; falling back to ReactHost")
        } catch (e: IllegalStateException) {
            Log.w(TAG, "Background service start blocked (${e.javaClass.simpleName}); falling back to ReactHost")
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException starting MusicWidgetTaskService: ${e.message}", e)
            clearLoadingState(context, prefs)
            return
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start MusicWidgetTaskService: ${e.message}", e)
            clearLoadingState(context, prefs)
            return
        }

        dispatchViaReactHostFallback(context, action, intent, prefs)
    }

    private fun clearLoadingState(context: Context, prefs: SharedPreferences) {
        prefs.edit()
            .putBoolean("is_loading", false)
            .putLong("loading_timestamp", 0L)
            .apply()
        MusicWidgetProvider.updateAllWidgets(context)
    }

    private fun dispatchViaReactHostFallback(
        context: Context,
        action: String,
        intent: Intent,
        prefs: SharedPreferences
    ) {
        val reactApp = context.applicationContext as? ReactApplication
        val reactHost = reactApp?.reactHost
        if (reactHost == null) {
            clearLoadingState(context, prefs)
            return
        }

        val pendingResult = goAsync()
        if (pendingResult == null) {
            clearLoadingState(context, prefs)
            return
        }

        val mainHandler = Handler(Looper.getMainLooper())
        val finished = AtomicBoolean(false)
        var instanceListener: ReactInstanceEventListener? = null

        fun finishPending() {
            if (finished.compareAndSet(false, true)) {
                mainHandler.removeCallbacksAndMessages(null)
                instanceListener?.let { reactHost.removeReactInstanceEventListener(it) }
                instanceListener = null
                try {
                    pendingResult.finish()
                } catch (_: Exception) {}
            }
        }

        // Guard BroadcastReceiver's ~10s execution budget
        mainHandler.postDelayed({
            Log.w(TAG, "goAsync headless fallback timed out for action=$action")
            clearLoadingState(context, prefs)
            finishPending()
        }, 9_000L)

        val taskData = Arguments.createMap().apply {
            putString("action", action)
            intent.getStringExtra("recent_id")?.let { putString("recentId", it) }
            intent.getStringExtra("recent_type")?.let { putString("recentType", it) }
            intent.getStringExtra("recent_title")?.let { putString("recentTitle", it) }
            intent.getStringExtra("recent_subtitle")?.let { putString("recentSubtitle", it) }
        }
        val taskConfig = HeadlessJsTaskConfig("MusicWidgetTask", taskData, 9_000L, true)

        fun runTaskOnContext(reactContext: ReactContext) {
            mainHandler.post {
                if (finished.get()) return@post
                try {
                    val taskContext = HeadlessJsTaskContext.getInstance(reactContext)
                    var startedTaskId = -1
                    val taskListener = object : HeadlessJsTaskEventListener {
                        override fun onHeadlessJsTaskStart(taskId: Int) {}
                        override fun onHeadlessJsTaskFinish(taskId: Int) {
                            if (startedTaskId == -1 || taskId == startedTaskId) {
                                taskContext.removeTaskEventListener(this)
                                finishPending()
                            }
                        }
                    }
                    taskContext.addTaskEventListener(taskListener)
                    startedTaskId = taskContext.startTask(taskConfig)
                } catch (e: Exception) {
                    Log.e(TAG, "ReactHost headless fallback failed: ${e.message}", e)
                    clearLoadingState(context, prefs)
                    finishPending()
                }
            }
        }

        try {
            val existingContext = reactHost.currentReactContext
            if (existingContext != null) {
                runTaskOnContext(existingContext)
            } else {
                val listener = object : ReactInstanceEventListener {
                    override fun onReactContextInitialized(context: ReactContext) {
                        reactHost.removeReactInstanceEventListener(this)
                        instanceListener = null
                        runTaskOnContext(context)
                    }
                }
                instanceListener = listener
                reactHost.addReactInstanceEventListener(listener)
                reactHost.start()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed initializing ReactHost for widget fallback: ${e.message}", e)
            clearLoadingState(context, prefs)
            finishPending()
        }
    }
}
