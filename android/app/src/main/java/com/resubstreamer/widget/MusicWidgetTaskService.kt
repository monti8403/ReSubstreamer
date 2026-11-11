package com.resubstreamer.widget

import android.content.Intent
import android.os.Bundle
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class MusicWidgetTaskService : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val extras: Bundle = intent?.extras ?: Bundle()
        return HeadlessJsTaskConfig(
            "MusicWidgetTask",
            Arguments.fromBundle(extras),
            30000,
            true
        )
    }
}
