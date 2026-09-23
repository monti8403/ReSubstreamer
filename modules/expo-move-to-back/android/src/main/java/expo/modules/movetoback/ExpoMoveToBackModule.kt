package expo.modules.movetoback

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoMoveToBackModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("ExpoMoveToBack")

        Function("moveToBack") {
            // moveTaskToBack is an Activity/UI operation and must run on the
            // main thread; this Function is invoked on the JS thread. Dispatch
            // to the UI thread (fire-and-forget — the call itself is trivial).
            // Safe-call (not `?: return@Function`) so the body's return shape
            // stays Unit? — the bare labelled return doesn't satisfy the Expo
            // `Function` DSL's expected return type and fails to compile.
            appContext.currentActivity?.let { activity ->
                activity.runOnUiThread { activity.moveTaskToBack(true) }
            }
        }

        Function("setSkipPreviousBehavior") { behavior: String ->
            val context = appContext.reactContext ?: appContext.currentActivity?.applicationContext
            val sp = context?.getSharedPreferences("substreamer_settings", Context.MODE_PRIVATE)
            sp?.edit()?.putString("skip_previous_behavior", behavior)?.apply()
        }
    }
}
