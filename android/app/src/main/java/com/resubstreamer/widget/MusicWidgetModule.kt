package com.resubstreamer.widget

import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class MusicWidgetModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

    companion object {
        const val PREFS_NAME = "widget_state_prefs"
        @Volatile
        var reactContext: ReactApplicationContext? = null
    }

    override fun getName(): String = "MusicWidgetModule"

    override fun initialize() {
        super.initialize()
        reactContext = reactApplicationContext
    }

    override fun invalidate() {
        super.invalidate()
        if (reactContext == reactApplicationContext) {
            reactContext = null
        }
    }

    @ReactMethod
    fun updateWidgetState(state: ReadableMap) {
        val prefs = reactApplicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val editor = prefs.edit()

        if (state.hasKey("trackId")) editor.putString("track_id", state.getString("trackId"))
        if (state.hasKey("title")) editor.putString("title", state.getString("title"))
        if (state.hasKey("artist")) editor.putString("artist", state.getString("artist"))
        if (state.hasKey("album")) editor.putString("album", state.getString("album"))
        if (state.hasKey("coverUri")) editor.putString("cover_uri", state.getString("coverUri"))
        if (state.hasKey("isPlaying")) editor.putBoolean("is_playing", state.getBoolean("isPlaying"))
        editor.putBoolean("is_loading", false)
        if (state.hasKey("isStarred")) editor.putBoolean("is_starred", state.getBoolean("isStarred"))
        if (state.hasKey("isShuffleActive")) editor.putBoolean("is_shuffle_active", state.getBoolean("isShuffleActive"))
        if (state.hasKey("widgetTheme")) editor.putString("widget_theme", state.getString("widgetTheme"))
        if (state.hasKey("widgetShuffleMode")) editor.putString("widget_shuffle_mode", state.getString("widgetShuffleMode"))
        if (state.hasKey("recentItems")) editor.putString("recent_items", state.getString("recentItems"))

        editor.apply()

        MusicWidgetProvider.updateAllWidgets(reactApplicationContext)
    }

    @ReactMethod
    fun getWidgetState(promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val map = Arguments.createMap().apply {
                putString("trackId", prefs.getString("track_id", ""))
                putString("title", prefs.getString("title", ""))
                putString("artist", prefs.getString("artist", ""))
                putString("album", prefs.getString("album", ""))
                putString("coverUri", prefs.getString("cover_uri", ""))
                putBoolean("isPlaying", prefs.getBoolean("is_playing", false))
                putBoolean("isStarred", prefs.getBoolean("is_starred", false))
                putBoolean("isShuffleActive", prefs.getBoolean("is_shuffle_active", false))
                putString("widgetTheme", prefs.getString("widget_theme", "dynamic"))
                putString("widgetShuffleMode", prefs.getString("widget_shuffle_mode", "toggle_queue"))
                putString("recentItems", prefs.getString("recent_items", "[]"))
            }
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("GET_WIDGET_STATE_ERROR", e.message, e)
        }
    }
}

