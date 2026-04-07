package __PACKAGE__.volumekey

import android.content.Intent
import android.provider.Settings
import android.view.KeyEvent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.modules.core.DeviceEventManagerModule

class VolumeKeyModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), VolumeKeyService.VolumeKeyListener {

    override fun getName(): String = "VolumeKey"

    @ReactMethod
    fun isAccessibilityEnabled(promise: Promise) {
        try {
            val enabled = VolumeKeyService.instance != null
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("VOLUME_KEY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun openAccessibilitySettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("VOLUME_KEY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun startListening(promise: Promise) {
        try {
            if (VolumeKeyService.instance == null) {
                promise.reject("VOLUME_KEY_ERROR", "Accessibility service not enabled")
                return
            }
            VolumeKeyService.listener = this
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("VOLUME_KEY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopListening(promise: Promise) {
        try {
            VolumeKeyService.listener = null
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("VOLUME_KEY_ERROR", e.message, e)
        }
    }

    override fun onVolumeKeyDown(keyCode: Int, eventTime: Long) {
        val params = Arguments.createMap().apply {
            putString("direction", if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) "up" else "down")
            putDouble("timestamp", eventTime.toDouble())
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("volumeKeyDown", params)
    }

    override fun onVolumeKeyUp(keyCode: Int, eventTime: Long) {
        val params = Arguments.createMap().apply {
            putString("direction", if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) "up" else "down")
            putDouble("timestamp", eventTime.toDouble())
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("volumeKeyUp", params)
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for RN event emitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for RN event emitter
    }
}
