package __PACKAGE__.foregroundservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.PowerManager
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import android.view.KeyEvent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.modules.core.DeviceEventManagerModule

class VoiceForegroundService : HeadlessJsTaskService() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var mediaSession: MediaSessionCompat? = null

    companion object {
        const val CHANNEL_ID = "voice_assistant_channel"
        const val NOTIFICATION_ID = 1001
        private const val TAG = "VoiceForegroundService"
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createNotificationChannel()
        val notification = buildNotification()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        acquireWakeLock()
        setupMediaSession()

        // Start the headless JS task to keep the JS thread alive
        super.onStartCommand(intent, flags, startId)

        return START_STICKY
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
        return HeadlessJsTaskConfig(
            "VoiceKeepAlive",
            Arguments.createMap(),
            0, // no timeout — long-running task
            true // allow in foreground
        )
    }

    override fun onDestroy() {
        releaseMediaSession()
        releaseWakeLock()
        super.onDestroy()
    }

    private fun setupMediaSession() {
        mediaSession = MediaSessionCompat(this, "HappyVoice").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onMediaButtonEvent(mediaButtonEvent: Intent?): Boolean {
                    val event = mediaButtonEvent?.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
                    if (event != null) {
                        val actionStr = when (event.action) {
                            KeyEvent.ACTION_DOWN -> "DOWN"
                            KeyEvent.ACTION_UP -> "UP"
                            else -> "ACTION_${event.action}"
                        }
                        val keyCodeStr = KeyEvent.keyCodeToString(event.keyCode)
                        Log.d(TAG, "MediaButton: keyCode=$keyCodeStr action=$actionStr repeat=${event.repeatCount}")

                        // Emit to JS for debugging
                        try {
                            val context = reactContext
                            if (context != null) {
                                val params = Arguments.createMap().apply {
                                    putInt("keyCode", event.keyCode)
                                    putString("keyCodeName", keyCodeStr)
                                    putString("action", actionStr)
                                    putInt("repeatCount", event.repeatCount)
                                }
                                context
                                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                    .emit("mediaButtonEvent", params)
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "Failed to emit media button event to JS", e)
                        }
                    }
                    return true // consume the event
                }
            })

            // Set playback state to playing so the system routes media buttons to us
            val playbackState = PlaybackStateCompat.Builder()
                .setState(PlaybackStateCompat.STATE_PLAYING, 0, 1f)
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY_PAUSE or
                    PlaybackStateCompat.ACTION_PLAY or
                    PlaybackStateCompat.ACTION_PAUSE or
                    PlaybackStateCompat.ACTION_STOP
                )
                .build()
            setPlaybackState(playbackState)

            isActive = true
        }
        Log.d(TAG, "MediaSession initialized")
    }

    private fun releaseMediaSession() {
        mediaSession?.let {
            it.isActive = false
            it.release()
        }
        mediaSession = null
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Voice Assistant",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps the voice assistant running in the background"
            setShowBadge(false)
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Voice Assistant")
            .setContentText("Listening in the background")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()
    }

    private fun acquireWakeLock() {
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "happy:voice_foreground"
        ).apply {
            acquire()
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
    }
}
