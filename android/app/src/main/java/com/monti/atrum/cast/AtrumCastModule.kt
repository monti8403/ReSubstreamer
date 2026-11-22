package com.monti.atrum.cast

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.MediaRoute2Info
import android.media.MediaRouter2
import android.media.RouteDiscoveryPreference
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt

class AtrumCastModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "AtrumCastModule"
        private const val TAG = "AtrumCastModule"
        private const val SSDP_ADDRESS = "239.255.255.250"
        private const val SSDP_PORT = 1900
        private const val EVENT_DEVICE_FOUND = "AtrumSsdpDeviceFound"
        private const val EVENT_SCAN_FINISHED = "AtrumSsdpScanFinished"
        private const val EVENT_SYSTEM_ROUTES_CHANGED = "AtrumSystemRoutesChanged"
        private const val PERMISSION_ACCESS_LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
        private const val MIN_TIMEOUT_MS = 1000
        private const val MAX_TIMEOUT_MS = 15000
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val discoveryExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "AtrumSsdpDiscovery").apply { isDaemon = true }
    }

    private val lockMonitor = Any()
    private val isScanning = AtomicBoolean(false)
    private val scanGeneration = AtomicLong(0L)

    @Volatile
    private var activeSocket: MulticastSocket? = null

    private var multicastLock: WifiManager.MulticastLock? = null
    private var systemRouterHelper: SystemRouterHelperApi34? = null

    override fun getName(): String = NAME

    override fun initialize() {
        super.initialize()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            mainHandler.post {
                try {
                    if (systemRouterHelper == null) {
                        systemRouterHelper = SystemRouterHelperApi34(reactApplicationContext) {
                            emitSystemRoutesChanged()
                        }.also { it.start() }
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "Failed to initialize SystemRouterHelperApi34", t)
                }
            }
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for React Native NativeEventEmitter compatibility.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for React Native NativeEventEmitter compatibility.
    }

    @ReactMethod
    fun checkLocalNetworkPermission(promise: Promise) {
        try {
            val pm = reactApplicationContext.packageManager
            try {
                pm.getPermissionInfo(PERMISSION_ACCESS_LOCAL_NETWORK, 0)
            } catch (_: PackageManager.NameNotFoundException) {
                promise.resolve("not_required")
                return
            }
            val granted = ContextCompat.checkSelfPermission(
                reactApplicationContext,
                PERMISSION_ACCESS_LOCAL_NETWORK,
            ) == PackageManager.PERMISSION_GRANTED
            promise.resolve(if (granted) "granted" else "denied")
        } catch (t: Throwable) {
            Log.w(TAG, "checkLocalNetworkPermission failed: ${t.message}")
            promise.resolve("not_required")
        }
    }

    @ReactMethod
    fun startSsdpDiscovery(timeoutMs: Int, promise: Promise) {
        val effectiveTimeout = timeoutMs.coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
        stopActiveScanInternal(emitFinished = false, reason = "restarted")

        val generation = scanGeneration.incrementAndGet()
        isScanning.set(true)
        acquireMulticastLock()

        discoveryExecutor.execute {
            runSsdpScan(generation, effectiveTimeout)
        }

        promise.resolve(null)
    }

    @ReactMethod
    fun stopSsdpDiscovery(promise: Promise) {
        stopActiveScanInternal(emitFinished = true, reason = "stopped")
        promise.resolve(null)
    }

    @ReactMethod
    fun openSystemOutputSwitcher(promise: Promise) {
        mainHandler.post {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    val shown = showMediaRouter2OutputSwitcher(reactApplicationContext)
                    if (shown) {
                        promise.resolve("mediarouter2")
                        return@post
                    }
                }

                val packageName = reactApplicationContext.packageName
                val mediaOutputIntent = Intent("com.android.settings.panel.action.MEDIA_OUTPUT").apply {
                    putExtra("com.android.settings.panel.extra.PACKAGE_NAME", packageName)
                }
                if (tryStartSettingsIntent(mediaOutputIntent)) {
                    promise.resolve("media_output_panel")
                    return@post
                }

                val bluetoothIntent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
                if (tryStartSettingsIntent(bluetoothIntent)) {
                    promise.resolve("bluetooth_settings")
                    return@post
                }

                val soundIntent = Intent(Settings.ACTION_SOUND_SETTINGS)
                if (tryStartSettingsIntent(soundIntent)) {
                    promise.resolve("sound_settings")
                    return@post
                }

                promise.reject("OUTPUT_SWITCHER_UNAVAILABLE", "No system audio output switcher available")
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to open system output switcher", t)
                promise.reject("OUTPUT_SWITCHER_ERROR", t.message ?: "Unknown error", t)
            }
        }
    }

    @ReactMethod
    fun getSystemAudioState(promise: Promise) {
        mainHandler.post {
            try {
                val audioManager =
                    reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                val maxVol = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
                val curVol = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC).coerceIn(0, maxVol)
                val volumePercent = ((curVol.toFloat() / maxVol.toFloat()) * 100f).roundToInt()

                val routesArray = Arguments.createArray()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    val helper = systemRouterHelper ?: SystemRouterHelperApi34(reactApplicationContext) {
                        emitSystemRoutesChanged()
                    }.also {
                        systemRouterHelper = it
                        it.start()
                    }
                    for (routeMap in helper.getSystemRoutes()) {
                        routesArray.pushMap(routeMap)
                    }
                }

                val result = Arguments.createMap().apply {
                    putInt("volumePercent", volumePercent)
                    putArray("routes", routesArray)
                }
                promise.resolve(result)
            } catch (t: Throwable) {
                promise.reject("SYSTEM_AUDIO_STATE_ERROR", t.message ?: "Unknown error", t)
            }
        }
    }

    @ReactMethod
    fun selectSystemAudioRoute(routeId: String, promise: Promise) {
        mainHandler.post {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    val helper = systemRouterHelper ?: SystemRouterHelperApi34(reactApplicationContext) {
                        emitSystemRoutesChanged()
                    }.also {
                        systemRouterHelper = it
                        it.start()
                    }
                    val transferred = helper.transferToRoute(routeId)
                    if (transferred) {
                        promise.resolve(true)
                        return@post
                    }
                }
                promise.resolve(false)
            } catch (t: Throwable) {
                promise.reject("SELECT_SYSTEM_ROUTE_ERROR", t.message ?: "Unknown error", t)
            }
        }
    }

    @ReactMethod
    fun setSystemMediaVolume(volumePercent: Int, promise: Promise) {
        mainHandler.post {
            try {
                val audioManager =
                    reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                val maxVol = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
                val clampedPct = volumePercent.coerceIn(0, 100)
                val targetIndex = ((clampedPct.toFloat() / 100f) * maxVol.toFloat()).roundToInt().coerceIn(0, maxVol)
                audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, targetIndex, 0)
                promise.resolve(clampedPct)
            } catch (t: Throwable) {
                promise.reject("SET_SYSTEM_VOLUME_ERROR", t.message ?: "Unknown error", t)
            }
        }
    }

    override fun invalidate() {
        super.invalidate()
        stopActiveScanInternal(emitFinished = false, reason = "invalidated")
        mainHandler.post {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                systemRouterHelper?.stop()
                systemRouterHelper = null
            }
        }
        discoveryExecutor.shutdownNow()
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun showMediaRouter2OutputSwitcher(context: Context): Boolean {
        return try {
            val router = MediaRouter2.getInstance(context)
            router.showSystemOutputSwitcher()
        } catch (t: Throwable) {
            Log.w(TAG, "MediaRouter2.showSystemOutputSwitcher failed", t)
            false
        }
    }

    private fun tryStartSettingsIntent(intent: Intent): Boolean {
        return try {
            val activity = reactApplicationContext.currentActivity
            if (activity != null && !activity.isFinishing) {
                activity.startActivity(intent)
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactApplicationContext.startActivity(intent)
            }
            true
        } catch (t: Throwable) {
            Log.d(TAG, "Intent ${intent.action} unavailable: ${t.message}")
            false
        }
    }

    private fun acquireMulticastLock() {
        synchronized(lockMonitor) {
            try {
                val wifiManager =
                    reactApplicationContext.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                if (wifiManager == null) return
                val lock = multicastLock ?: wifiManager.createMulticastLock("AtrumSsdpMulticastLock").apply {
                    setReferenceCounted(false)
                }
                multicastLock = lock
                if (!lock.isHeld) {
                    lock.acquire()
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to acquire WifiManager.MulticastLock", t)
            }
        }
    }

    private fun releaseMulticastLock() {
        synchronized(lockMonitor) {
            try {
                val lock = multicastLock
                if (lock != null && lock.isHeld) {
                    lock.release()
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to release WifiManager.MulticastLock", t)
            }
        }
    }

    private fun stopActiveScanInternal(emitFinished: Boolean, reason: String) {
        val wasScanning = isScanning.getAndSet(false)
        scanGeneration.incrementAndGet()
        closeActiveSocket()
        releaseMulticastLock()
        if (emitFinished && wasScanning) {
            emitScanFinished(reason, 0, 0)
        }
    }

    private fun closeActiveSocket() {
        synchronized(lockMonitor) {
            try {
                activeSocket?.close()
            } catch (_: Throwable) {
                // ignore close errors
            } finally {
                activeSocket = null
            }
        }
    }

    private data class WifiBindTarget(
        val network: Network?,
        val networkInterface: NetworkInterface?,
        val ipv4Address: Inet4Address?,
    )

    private fun extractBindTarget(cm: ConnectivityManager, network: Network): WifiBindTarget? {
        val caps = cm.getNetworkCapabilities(network) ?: return null
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
            return null
        }
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
            !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        ) {
            return null
        }
        val lp = cm.getLinkProperties(network) ?: return null
        val ipv4 = lp.linkAddresses
            .map { it.address }
            .firstOrNull { it is Inet4Address && !it.isLoopbackAddress } as? Inet4Address
        val ifName = lp.interfaceName
        val netIf = when {
            !ifName.isNullOrBlank() -> NetworkInterface.getByName(ifName)
            ipv4 != null -> NetworkInterface.getByInetAddress(ipv4)
            else -> null
        }
        if (ipv4 != null || netIf != null) {
            return WifiBindTarget(network, netIf, ipv4)
        }
        return null
    }

    private fun resolveWifiBindTarget(): WifiBindTarget {
        try {
            val cm = reactApplicationContext.applicationContext
                .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            if (cm != null) {
                cm.activeNetwork?.let { active ->
                    extractBindTarget(cm, active)?.let { return it }
                }
                val networks = cm.allNetworks
                for (network in networks) {
                    extractBindTarget(cm, network)?.let { return it }
                }
            }
        } catch (t: Throwable) {
            Log.d(TAG, "ConnectivityManager lookup failed: ${t.message}")
        }

        // Fallback enumeration if ConnectivityManager didn't yield a Wi-Fi IPv4 interface
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            var fallbackNetIf: NetworkInterface? = null
            var fallbackAddr: Inet4Address? = null
            while (interfaces != null && interfaces.hasMoreElements()) {
                val netIf = interfaces.nextElement()
                val name = netIf.name.lowercase()
                if (!netIf.isUp || netIf.isLoopback || netIf.isPointToPoint) continue
                if (name.startsWith("tun") || name.startsWith("ppp") || name.startsWith("rmnet") ||
                    name.startsWith("ccmni") || name.startsWith("p2p") || name.startsWith("dummy")
                ) {
                    continue
                }
                val ipv4 = netIf.inetAddresses.toList()
                    .firstOrNull { it is Inet4Address && !it.isLoopbackAddress } as? Inet4Address
                    ?: continue
                if (name.startsWith("wlan") || name.startsWith("wifi") || name.startsWith("eth")) {
                    return WifiBindTarget(null, netIf, ipv4)
                }
                if (fallbackNetIf == null) {
                    fallbackNetIf = netIf
                    fallbackAddr = ipv4
                }
            }
            if (fallbackNetIf != null) {
                return WifiBindTarget(null, fallbackNetIf, fallbackAddr)
            }
        } catch (_: Throwable) {
            // ignore
        }
        return WifiBindTarget(null, null, null)
    }

    private fun runSsdpScan(generation: Long, timeoutMs: Int) {
        val seenLocations = ConcurrentHashMap.newKeySet<String>()
        var socket: MulticastSocket? = null
        var finishReason = "timeout"
        var packetsReceived = 0

        try {
            val bindTarget = resolveWifiBindTarget()
            socket = MulticastSocket(null).apply {
                reuseAddress = true
                broadcast = true
                if (bindTarget.ipv4Address != null) {
                    bind(InetSocketAddress(bindTarget.ipv4Address, 0))
                } else {
                    bind(InetSocketAddress(0))
                }
                timeToLive = 4
                soTimeout = 350
            }
            bindTarget.network?.let { network ->
                try {
                    network.bindSocket(socket)
                } catch (t: Throwable) {
                    Log.w(TAG, "Network.bindSocket failed: ${t.message}")
                }
            }
            bindTarget.networkInterface?.let { netIf ->
                try {
                    socket.networkInterface = netIf
                } catch (t: Throwable) {
                    Log.w(TAG, "Could not set multicast networkInterface ${netIf.name}: ${t.message}")
                }
            }

            Log.i(
                TAG,
                "SSDP scan started (iface=${bindTarget.networkInterface?.name ?: "default"}, ip=${bindTarget.ipv4Address?.hostAddress ?: "0.0.0.0"}, boundNet=${bindTarget.network != null})",
            )

            synchronized(lockMonitor) {
                if (!isScanning.get() || scanGeneration.get() != generation) {
                    socket.close()
                    return
                }
                activeSocket = socket
            }

            val groupAddress = InetAddress.getByName(SSDP_ADDRESS)
            val targets = listOf(
                "urn:schemas-upnp-org:device:MediaRenderer:1",
                "urn:schemas-upnp-org:service:AVTransport:1",
                "upnp:rootdevice",
                "ssdp:all",
            )

            sendMSearchBurst(socket, groupAddress, targets, generation)

            val deadlineMs = System.currentTimeMillis() + timeoutMs
            val secondBurstAt = System.currentTimeMillis() + 650L
            var secondBurstSent = false
            val buffer = ByteArray(4096)

            while (isScanning.get() && scanGeneration.get() == generation) {
                val now = System.currentTimeMillis()
                if (!secondBurstSent && now >= secondBurstAt) {
                    secondBurstSent = true
                    sendMSearchBurst(socket, groupAddress, targets, generation)
                }
                if (now >= deadlineMs) {
                    break
                }

                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    packetsReceived += 1
                    val raw = String(packet.data, 0, packet.length, Charsets.UTF_8)
                    val headers = parseSsdpHeaders(raw)
                    val location = headers["location"]?.trim()
                    if (!location.isNullOrEmpty() && seenLocations.add(location)) {
                        Log.i(TAG, "SSDP location found: $location (st=${headers["st"]})")
                        emitDeviceFound(
                            location = location,
                            usn = headers["usn"] ?: "",
                            st = headers["st"] ?: "",
                            server = headers["server"] ?: "",
                        )
                    }
                } catch (_: SocketTimeoutException) {
                    // Continue polling until deadline or stop
                } catch (se: SocketException) {
                    if (!isScanning.get() || scanGeneration.get() != generation) {
                        finishReason = "stopped"
                        break
                    }
                    Log.w(TAG, "SSDP socket receive error: ${se.message}")
                    finishReason = "error"
                    break
                }
            }
        } catch (t: Throwable) {
            if (isScanning.get() && scanGeneration.get() == generation) {
                Log.w(TAG, "SSDP scan failed", t)
                finishReason = "error"
            } else {
                finishReason = "stopped"
            }
        } finally {
            try {
                socket?.close()
            } catch (_: Throwable) {
                // ignore
            }
            var shouldEmitFinish = false
            synchronized(lockMonitor) {
                if (activeSocket === socket) {
                    activeSocket = null
                }
                if (scanGeneration.get() == generation) {
                    isScanning.set(false)
                    releaseMulticastLock()
                    shouldEmitFinish = true
                }
            }
            Log.i(TAG, "SSDP scan finished ($finishReason): packets=$packetsReceived locations=${seenLocations.size}")
            if (shouldEmitFinish) {
                emitScanFinished(finishReason, packetsReceived, seenLocations.size)
            }
        }
    }

    private fun sendMSearchBurst(
        socket: MulticastSocket,
        groupAddress: InetAddress,
        targets: List<String>,
        generation: Long,
    ) {
        for (target in targets) {
            if (!isScanning.get() || scanGeneration.get() != generation) return
            val payload = buildString {
                append("M-SEARCH * HTTP/1.1\r\n")
                append("HOST: ").append(SSDP_ADDRESS).append(":").append(SSDP_PORT).append("\r\n")
                append("MAN: \"ssdp:discover\"\r\n")
                append("MX: 2\r\n")
                append("ST: ").append(target).append("\r\n")
                append("\r\n")
            }.toByteArray(Charsets.UTF_8)

            try {
                val packet = DatagramPacket(payload, payload.size, groupAddress, SSDP_PORT)
                socket.send(packet)
                Thread.sleep(50L)
            } catch (_: InterruptedException) {
                return
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to send M-SEARCH for $target: ${t.message}")
            }
        }
    }

    private fun parseSsdpHeaders(raw: String): Map<String, String> {
        val headers = HashMap<String, String>()
        val lines = raw.split("\r\n", "\n")
        for (line in lines) {
            val colonIdx = line.indexOf(':')
            if (colonIdx <= 0) continue
            val key = line.substring(0, colonIdx).trim().lowercase()
            val value = line.substring(colonIdx + 1).trim()
            if (key.isNotEmpty() && !headers.containsKey(key)) {
                headers[key] = value
            }
        }
        return headers
    }

    private fun emitDeviceFound(location: String, usn: String, st: String, server: String) {
        if (!reactApplicationContext.hasActiveReactInstance()) return
        val params = Arguments.createMap().apply {
            putString("location", location)
            putString("usn", usn)
            putString("st", st)
            putString("server", server)
        }
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_DEVICE_FOUND, params)
    }

    private fun emitScanFinished(reason: String, packetsReceived: Int, locationsCount: Int) {
        if (!reactApplicationContext.hasActiveReactInstance()) return
        val params = Arguments.createMap().apply {
            putString("reason", reason)
            putInt("packetsReceived", packetsReceived)
            putInt("locationsCount", locationsCount)
        }
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_SCAN_FINISHED, params)
    }

    private fun emitSystemRoutesChanged() {
        if (!reactApplicationContext.hasActiveReactInstance()) return
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_SYSTEM_ROUTES_CHANGED, Arguments.createMap())
    }
}

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
private class SystemRouterHelperApi34(
    context: Context,
    private val onRoutesUpdated: () -> Unit,
) {
    private val router = MediaRouter2.getInstance(context)
    private val executor = context.mainExecutor
    private var registered = false

    private val routeCallback = object : MediaRouter2.RouteCallback() {
        override fun onRoutesUpdated(routes: MutableList<MediaRoute2Info>) {
            onRoutesUpdated()
        }
    }

    private val transferCallback = object : MediaRouter2.TransferCallback() {
        override fun onTransfer(
            oldController: MediaRouter2.RoutingController,
            newController: MediaRouter2.RoutingController,
        ) {
            onRoutesUpdated()
        }

        override fun onStop(controller: MediaRouter2.RoutingController) {
            onRoutesUpdated()
        }
    }

    fun start() {
        if (registered) return
        registered = true
        val pref = RouteDiscoveryPreference.Builder(
            listOf(MediaRoute2Info.FEATURE_LIVE_AUDIO),
            false,
        ).build()
        router.registerRouteCallback(executor, routeCallback, pref)
        router.registerTransferCallback(executor, transferCallback)
    }

    fun stop() {
        if (!registered) return
        registered = false
        runCatching { router.unregisterRouteCallback(routeCallback) }
        runCatching { router.unregisterTransferCallback(transferCallback) }
    }

    fun getSystemRoutes(): List<WritableMap> {
        val selectedIds = router.systemController.selectedRoutes.map { it.id }.toSet()
        val systemRoutes = router.routes.filter { it.isSystemRoute }
        val seen = HashSet<String>()
        val result = ArrayList<WritableMap>(systemRoutes.size)
        for (route in systemRoutes) {
            if (!seen.add(route.id)) continue
            result.add(
                Arguments.createMap().apply {
                    putString("id", route.id)
                    putString("name", route.name.toString())
                    putString("kind", mapRouteKind(route.type))
                    putBoolean("isSelected", selectedIds.contains(route.id))
                },
            )
        }
        return result
    }

    fun transferToRoute(routeId: String): Boolean {
        val target = router.routes.firstOrNull { it.isSystemRoute && it.id == routeId }
            ?: return false
        router.transferTo(target)
        return true
    }

    private fun mapRouteKind(type: Int): String = when (type) {
        MediaRoute2Info.TYPE_BLUETOOTH_A2DP,
        MediaRoute2Info.TYPE_BLE_HEADSET,
        MediaRoute2Info.TYPE_HEARING_AID -> "bluetooth"
        MediaRoute2Info.TYPE_WIRED_HEADSET,
        MediaRoute2Info.TYPE_WIRED_HEADPHONES -> "wired"
        MediaRoute2Info.TYPE_USB_DEVICE,
        MediaRoute2Info.TYPE_USB_ACCESSORY,
        MediaRoute2Info.TYPE_USB_HEADSET -> "usb"
        MediaRoute2Info.TYPE_HDMI -> "hdmi"
        MediaRoute2Info.TYPE_BUILTIN_SPEAKER -> "speaker"
        else -> "unknown"
    }
}
