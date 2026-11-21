package com.monti.atrum.cast

import android.content.Context
import android.content.Intent
import android.media.MediaRouter2
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.annotation.RequiresApi
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
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

class AtrumCastModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "AtrumCastModule"
        private const val TAG = "AtrumCastModule"
        private const val SSDP_ADDRESS = "239.255.255.250"
        private const val SSDP_PORT = 1900
        private const val EVENT_DEVICE_FOUND = "AtrumSsdpDeviceFound"
        private const val EVENT_SCAN_FINISHED = "AtrumSsdpScanFinished"
        private const val DEFAULT_TIMEOUT_MS = 5000
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

    override fun getName(): String = NAME

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for React Native NativeEventEmitter compatibility.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for React Native NativeEventEmitter compatibility.
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

    override fun invalidate() {
        super.invalidate()
        stopActiveScanInternal(emitFinished = false, reason = "invalidated")
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
            emitScanFinished(reason)
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

    private fun findWifiMulticastInterface(): NetworkInterface? {
        return try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return null
            var fallback: NetworkInterface? = null
            while (interfaces.hasMoreElements()) {
                val netIf = interfaces.nextElement()
                if (!netIf.isUp || netIf.isLoopback || netIf.isPointToPoint || !netIf.supportsMulticast()) {
                    continue
                }
                val hasIpv4 = netIf.inetAddresses.toList().any { it is Inet4Address && !it.isLoopbackAddress }
                if (!hasIpv4) continue
                val name = netIf.name.lowercase()
                if (name.startsWith("wlan") || name.startsWith("wifi")) {
                    return netIf
                }
                if (fallback == null) {
                    fallback = netIf
                }
            }
            fallback
        } catch (_: Throwable) {
            null
        }
    }

    private fun runSsdpScan(generation: Long, timeoutMs: Int) {
        val seenLocations = ConcurrentHashMap.newKeySet<String>()
        var socket: MulticastSocket? = null
        var finishReason = "timeout"

        try {
            socket = MulticastSocket(null).apply {
                reuseAddress = true
                bind(InetSocketAddress(0))
                soTimeout = 400
            }
            findWifiMulticastInterface()?.let { netIf ->
                try {
                    socket.networkInterface = netIf
                } catch (t: Throwable) {
                    Log.d(TAG, "Could not bind multicast networkInterface: ${t.message}")
                }
            }

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
                "ssdp:all",
            )

            sendMSearchBurst(socket, groupAddress, targets)

            val deadlineMs = System.currentTimeMillis() + timeoutMs
            val secondBurstAt = System.currentTimeMillis() + 350L
            var secondBurstSent = false
            val buffer = ByteArray(4096)

            while (isScanning.get() && scanGeneration.get() == generation) {
                val now = System.currentTimeMillis()
                if (!secondBurstSent && now >= secondBurstAt) {
                    secondBurstSent = true
                    sendMSearchBurst(socket, groupAddress, targets)
                }
                if (now >= deadlineMs) {
                    break
                }

                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val raw = String(packet.data, 0, packet.length, Charsets.UTF_8)
                    val headers = parseSsdpHeaders(raw)
                    val location = headers["location"]?.trim()
                    if (!location.isNullOrEmpty() && seenLocations.add(location)) {
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
            if (shouldEmitFinish) {
                emitScanFinished(finishReason)
            }
        }
    }

    private fun sendMSearchBurst(
        socket: MulticastSocket,
        groupAddress: InetAddress,
        targets: List<String>,
    ) {
        for (target in targets) {
            val payload = buildString {
                append("M-SEARCH * HTTP/1.1\r\n")
                append("HOST: ").append(SSDP_ADDRESS).append(":").append(SSDP_PORT).append("\r\n")
                append("MAN: \"ssdp:discover\"\r\n")
                append("MX: 3\r\n")
                append("ST: ").append(target).append("\r\n")
                append("\r\n")
            }.toByteArray(Charsets.UTF_8)

            try {
                val packet = DatagramPacket(payload, payload.size, groupAddress, SSDP_PORT)
                socket.send(packet)
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

    private fun emitScanFinished(reason: String) {
        if (!reactApplicationContext.hasActiveReactInstance()) return
        val params = Arguments.createMap().apply {
            putString("reason", reason)
        }
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_SCAN_FINISHED, params)
    }
}
