import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Linking,
  NativeModules,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
  WebViewNavigation,
} from 'react-native-webview/lib/WebViewTypes';

const APP_URL = 'https://app.healz.ai';
const INTERNAL_HOSTS = new Set(['app.healz.ai', 'healz.ai', 'www.healz.ai']);
const MOBILE_CHROME_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

type SharedDocument = {
  uri: string;
  name: string;
  type: string;
  size: number;
  base64: string;
};

type SharedDocumentModule = {
  getPendingShare: () => Promise<SharedDocument | null>;
  clearPendingShare: () => void;
};

type WebShareMessage = {
  source: 'healz-share-target';
  status: 'attached' | 'waiting' | 'error';
  message: string;
};

const sharedDocumentModule = NativeModules.SharedDocument as SharedDocumentModule | undefined;

function isInternalUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol.startsWith('http') && INTERNAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function isSystemUrl(url: string) {
  return /^(mailto:|tel:|sms:|maps:|geo:)/i.test(url);
}

function isHttpUrl(url: string) {
  return /^https?:/i.test(url);
}

function createAttachSharedDocumentInjection(document: SharedDocument) {
  const payload = JSON.stringify(document);

  return `
    (function attachSharedDocument() {
      var sharedDocument = ${payload};

      var report = function (status, message) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          source: 'healz-share-target',
          status: status,
          message: message
        }));
      };

      var findFileInput = function () {
        return document.querySelector('input[type="file"]:not([disabled])');
      };

      var findAttachControl = function () {
        var direct = document.querySelector('button[aria-label="Attach file"]:not([disabled])');
        if (direct) {
          return direct;
        }

        var controls = Array.prototype.slice.call(document.querySelectorAll(
          'button:not([disabled]), [role="button"], label[for]'
        ));

        return controls.find(function (candidate) {
          var description = [
            candidate.getAttribute('aria-label'),
            candidate.getAttribute('title'),
            candidate.textContent,
            candidate.getAttribute('class')
          ].filter(Boolean).join(' ').toLowerCase();

          return /attach|upload|file|paperclip|document/.test(description);
        });
      };

      var base64ToBytes = function (base64) {
        var binary = window.atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      };

      var attachToInput = function (input) {
        var file = new File(
          [base64ToBytes(sharedDocument.base64)],
          sharedDocument.name,
          { type: sharedDocument.type }
        );
        var transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        report('attached', 'Shared file was passed to Healz.');
      };

      var tryAttach = function () {
        var input = findFileInput();
        if (input) {
          attachToInput(input);
          return;
        }

        var attachButton = findAttachControl();
        if (attachButton) {
          attachButton.click();
          setTimeout(function () {
            var nextInput = findFileInput();
            if (nextInput) {
              attachToInput(nextInput);
              return;
            }

            report(
              'waiting',
              'Finish login in Healz. The shared document will attach after the chat is ready.'
            );
          }, 500);
          return;
        }

        report('error', 'Open a Healz chat first, then share the document again.');
      };

      try {
        tryAttach();
      } catch (error) {
        report('error', 'Could not pass the shared document to Healz.');
      }

      return true;
    })();
  `;
}

export default function App() {
  const webViewRef = useRef<WebView>(null);
  const pendingSharedDocumentRef = useRef<SharedDocument | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingSharedDocument, setPendingSharedDocument] = useState<SharedDocument | null>(null);
  const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);

  useEffect(() => {
    const backSubscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (!canGoBack) {
          return false;
        }

        webViewRef.current?.goBack();
        return true;
      }
    );

    return () => {
      backSubscription.remove();
    };
  }, [canGoBack]);

  useEffect(() => {
    pendingSharedDocumentRef.current = pendingSharedDocument;
  }, [pendingSharedDocument]);

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      console.warn('Unable to open external URL', error);
    }
  }, []);

  const handleNavigationStateChange = useCallback((state: WebViewNavigation) => {
    setCanGoBack(state.canGoBack);
  }, []);

  const handleShouldStartLoad = useCallback(
    (request: ShouldStartLoadRequest) => {
      const { url } = request;

      if (!url) {
        return false;
      }

      if (
        url.startsWith('about:blank') ||
        url.startsWith('data:') ||
        url.startsWith('blob:')
      ) {
        return true;
      }

      if (isSystemUrl(url)) {
        openExternalUrl(url);
        return false;
      }

      if (isInternalUrl(url)) {
        return true;
      }

      if (!isHttpUrl(url)) {
        openExternalUrl(url);
        return false;
      }

      openExternalUrl(url);
      return false;
    },
    [openExternalUrl]
  );

  const handleLoadStart = useCallback(() => {
    setLoadError(null);
    setIsWebViewReady(false);
  }, []);

  const handleLoadEnd = useCallback(() => {
    setIsWebViewReady(true);
  }, []);

  const handleLoadError = useCallback((event: WebViewErrorEvent) => {
    const { description, url } = event.nativeEvent;
    const fallbackText =
      'Cannot open Healz. Check internet inside the emulator or try a real Android device.';
    setLoadError(`${description || fallbackText}\n${url || APP_URL}`);
  }, []);

  const handleHttpError = useCallback((event: WebViewHttpErrorEvent) => {
    const { statusCode, description, url } = event.nativeEvent;
    setLoadError(`HTTP ${statusCode}: ${description || 'Request failed'}\n${url || APP_URL}`);
  }, []);

  const handleRetry = useCallback(() => {
    setLoadError(null);
    webViewRef.current?.reload();
  }, []);

  const handleOpenInBrowser = useCallback(() => {
    openExternalUrl(APP_URL);
  }, [openExternalUrl]);

  const checkPendingShare = useCallback(async () => {
    if (Platform.OS !== 'android' || !sharedDocumentModule || pendingSharedDocumentRef.current) {
      return;
    }

    try {
      const document = await sharedDocumentModule.getPendingShare();
      if (!document) {
        return;
      }

      setPendingSharedDocument(document);
      setShareStatus(`Preparing ${document.name} for Healz...`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read shared document.';
      Alert.alert('Could not import shared document', message);
      sharedDocumentModule.clearPendingShare();
    }
  }, []);

  useEffect(() => {
    checkPendingShare();
    const interval = setInterval(checkPendingShare, 1200);

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        checkPendingShare();
      }
    });

    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [checkPendingShare]);

  useEffect(() => {
    if (!isWebViewReady || !pendingSharedDocument) {
      return;
    }

    setShareStatus(`Attaching ${pendingSharedDocument.name} in Healz...`);
    webViewRef.current?.injectJavaScript(
      createAttachSharedDocumentInjection(pendingSharedDocument)
    );
  }, [isWebViewReady, pendingSharedDocument]);

  const handleWebMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const message = JSON.parse(event.nativeEvent.data) as WebShareMessage;
        if (message.source !== 'healz-share-target') {
          return;
        }

        if (message.status === 'waiting') {
          setShareStatus(message.message);
          sharedDocumentModule?.clearPendingShare();
          return;
        }

        setPendingSharedDocument(null);
        setShareStatus(null);
        sharedDocumentModule?.clearPendingShare();

        if (message.status === 'error') {
          Alert.alert('Could not attach shared document', message.message);
        }
      } catch {
        // Ignore messages originating from the website itself.
      }
    },
    []
  );

  const renderLoading = useCallback(
    () => (
      <View style={styles.loader}>
        <ActivityIndicator size="large" color="#122033" />
      </View>
    ),
    []
  );

  const renderError = useCallback(() => {
    return (
      <View style={styles.errorCard}>
        <Text style={styles.errorTitle}>Healz is unavailable</Text>
        <Text style={styles.errorText}>{loadError ?? 'Unknown network error'}</Text>
        <Pressable style={styles.primaryButton} onPress={handleRetry}>
          <Text style={styles.primaryButtonText}>Retry</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={handleOpenInBrowser}>
          <Text style={styles.secondaryButtonText}>Open in browser</Text>
        </Pressable>
      </View>
    );
  }, [handleOpenInBrowser, handleRetry, loadError]);

  const webView = (
    <WebView
      ref={webViewRef}
      source={{ uri: APP_URL }}
      style={styles.webview}
      onLoadStart={handleLoadStart}
      onNavigationStateChange={handleNavigationStateChange}
      onShouldStartLoadWithRequest={handleShouldStartLoad}
      onError={handleLoadError}
      onHttpError={handleHttpError}
      onMessage={handleWebMessage}
      onLoadEnd={handleLoadEnd}
      javaScriptEnabled
      domStorageEnabled
      cacheEnabled
      sharedCookiesEnabled
      thirdPartyCookiesEnabled
      allowsBackForwardNavigationGestures
      scalesPageToFit={false}
      originWhitelist={['http://*', 'https://*', 'mailto:*', 'tel:*', 'sms:*']}
      userAgent={MOBILE_CHROME_USER_AGENT}
      setSupportMultipleWindows={false}
      startInLoadingState
      renderLoading={renderLoading}
      renderError={renderError}
    />
  );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
        <StatusBar style="dark" />
        <View style={styles.container}>
          {webView}
          {shareStatus && !loadError && (
            <View style={styles.shareStatus} pointerEvents="none">
              <ActivityIndicator color="#ffffff" size="small" />
              <Text style={styles.shareStatusText}>{shareStatus}</Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  webview: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  shareStatus: {
    position: 'absolute',
    right: 14,
    bottom: 18,
    left: 14,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 18,
    backgroundColor: '#2f2530',
    paddingHorizontal: 16,
    shadowColor: '#2f2530',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 12,
    elevation: 7,
  },
  shareStatusText: {
    flex: 1,
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  errorCard: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#ffffff',
    gap: 14,
  },
  errorTitle: {
    color: '#122033',
    fontSize: 28,
    fontWeight: '700',
  },
  errorText: {
    color: '#435060',
    fontSize: 15,
    lineHeight: 22,
  },
  primaryButton: {
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: '#122033',
    paddingVertical: 14,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d5dce5',
    backgroundColor: '#ffffff',
    paddingVertical: 14,
  },
  secondaryButtonText: {
    color: '#122033',
    fontSize: 16,
    fontWeight: '600',
  },
});
