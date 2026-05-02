package com.voice.shooter;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.view.WindowManager;

import java.util.ArrayList;
import java.util.Locale;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int REQ_RECORD_AUDIO = 1001;
    private SpeechRecognizer speechRecognizer;
    private boolean recognizerReady = false;
    private boolean listening = false;
    private AudioManager audioManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        ensureMicrophonePermission();
        setupSpeechBridge();
    }

    @Override
    public void onDestroy() {
        stopAndReleaseRecognizer();
        super.onDestroy();
    }

    @Override
    public void onPause() {
        stopRecognizerOnly();
        super.onPause();
    }

    @Override
    public void onStop() {
        stopRecognizerOnly();
        super.onStop();
    }

    @Override
    public void onBackPressed() {
        stopAndReleaseRecognizer();
        super.onBackPressed();
    }

    private void ensureMicrophonePermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                new String[]{Manifest.permission.RECORD_AUDIO},
                REQ_RECORD_AUDIO
            );
        }
    }

    private void setupSpeechBridge() {
        if (bridge == null || bridge.getWebView() == null) return;
        bridge.getWebView().addJavascriptInterface(new AndroidVoiceBridge(), "AndroidVoice");
    }

    private void stopRecognizerOnly() {
        try {
            if (speechRecognizer != null) speechRecognizer.cancel();
        } catch (Exception ignored) {}
        listening = false;
    }

    private void stopAndReleaseRecognizer() {
        try {
            if (speechRecognizer != null) {
                speechRecognizer.cancel();
                speechRecognizer.destroy();
            }
        } catch (Exception ignored) {}
        speechRecognizer = null;
        recognizerReady = false;
        listening = false;
    }

    private void ensureRecognizer() {
        if (recognizerReady || !SpeechRecognizer.isRecognitionAvailable(this)) return;
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
        speechRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                listening = true;
                sendVoiceEvent("ready", "");
            }

            @Override
            public void onBeginningOfSpeech() {
                sendVoiceEvent("begin", "");
            }

            @Override
            public void onRmsChanged(float rmsdB) {}

            @Override
            public void onBufferReceived(byte[] buffer) {}

            @Override
            public void onEndOfSpeech() {
                listening = false;
                sendVoiceEvent("end", "");
            }

            @Override
            public void onError(int error) {
                listening = false;
                sendVoiceEvent("error", String.valueOf(error));
            }

            @Override
            public void onResults(Bundle results) {
                listening = false;
                ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                String text = (matches != null && !matches.isEmpty()) ? matches.get(0) : "";
                sendVoiceEvent("result", text);
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                String text = (matches != null && !matches.isEmpty()) ? matches.get(0) : "";
                if (!text.isEmpty()) sendVoiceEvent("partial", text);
            }

            @Override
            public void onEvent(int eventType, Bundle params) {}
        });
        recognizerReady = true;
    }

    private void sendVoiceEvent(String type, String text) {
        if (bridge == null || bridge.getWebView() == null) return;
        final String safeType = escapeJs(type);
        final String safeText = escapeJs(text);
        runOnUiThread(() -> bridge.getWebView().evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('android-voice', { detail: { type: '" + safeType + "', text: '" + safeText + "' } }));",
            null
        ));
    }

    private String escapeJs(String value) {
        if (value == null) return "";
        return value
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", " ")
            .replace("\r", " ");
    }

    private class AndroidVoiceBridge {
        private void setSystemMute(boolean mute) {
            if (audioManager == null) return;
            try {
                if (android.os.Build.VERSION.SDK_INT >= 23) {
                    audioManager.adjustStreamVolume(
                        AudioManager.STREAM_SYSTEM,
                        mute ? AudioManager.ADJUST_MUTE : AudioManager.ADJUST_UNMUTE,
                        0
                    );
                } else {
                    audioManager.setStreamMute(AudioManager.STREAM_SYSTEM, mute);
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public boolean isAvailable() {
            return SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
        }

        @JavascriptInterface
        public boolean hasPermission() {
            return ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void requestPermission() {
            runOnUiThread(() -> ensureMicrophonePermission());
        }

        @JavascriptInterface
        public boolean isListening() {
            return listening;
        }

        @JavascriptInterface
        public void start() {
            runOnUiThread(() -> {
                ensureRecognizer();
                if (speechRecognizer == null) {
                    sendVoiceEvent("error", "unavailable");
                    return;
                }
                if (!hasPermission()) {
                    ensureMicrophonePermission();
                    sendVoiceEvent("error", "permission");
                    return;
                }
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.KOREA.toLanguageTag());
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 260L);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 180L);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 260L);
                intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
                try {
                    setSystemMute(true);
                    speechRecognizer.startListening(intent);
                    mainHandler.postDelayed(() -> setSystemMute(false), 350);
                    sendVoiceEvent("start", "");
                } catch (Exception e) {
                    listening = false;
                    setSystemMute(false);
                    sendVoiceEvent("error", "start_failed");
                }
            });
        }

        @JavascriptInterface
        public void stop() {
            runOnUiThread(() -> {
                if (speechRecognizer != null) {
                    speechRecognizer.stopListening();
                }
                listening = false;
            });
        }
    }
}
