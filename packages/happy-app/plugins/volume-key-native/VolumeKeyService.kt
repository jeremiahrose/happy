package __PACKAGE__.volumekey

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

class VolumeKeyService : AccessibilityService() {

    companion object {
        var instance: VolumeKeyService? = null
            private set
        var listener: VolumeKeyListener? = null
    }

    interface VolumeKeyListener {
        fun onVolumeKeyDown(keyCode: Int, eventTime: Long)
        fun onVolumeKeyUp(keyCode: Int, eventTime: Long)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this

        val info = AccessibilityServiceInfo().apply {
            // We only need key event filtering, no other accessibility features
            eventTypes = 0
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS
            notificationTimeout = 0
        }
        serviceInfo = info
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        val keyCode = event.keyCode
        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) {
            return false
        }

        // Only intercept when a listener is registered (voice session active)
        val currentListener = listener ?: return false

        when (event.action) {
            KeyEvent.ACTION_DOWN -> {
                // Ignore repeats from holding - we only want the initial press
                if (event.repeatCount == 0) {
                    currentListener.onVolumeKeyDown(keyCode, event.eventTime)
                }
            }
            KeyEvent.ACTION_UP -> {
                currentListener.onVolumeKeyUp(keyCode, event.eventTime)
            }
        }

        // Return true to consume the event (prevents volume change)
        return true
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Not used - we only care about key events
    }

    override fun onInterrupt() {
        // Required override
    }

    override fun onDestroy() {
        instance = null
        listener = null
        super.onDestroy()
    }
}
