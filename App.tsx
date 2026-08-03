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
const SHARE_READ_TIMEOUT_MS = 30_000;
const SHARE_ATTACH_TIMEOUT_MS = 60_000;
const INTERNAL_HOSTS = new Set(['app.healz.ai', 'healz.ai', 'www.healz.ai']);
const MOBILE_CHROME_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

// The landing page calculates a different responsive layout after the first
// viewport change (for example, when the keyboard opens). Ask it to recalculate
// a few times while it hydrates. Authenticated Healz screens additionally carry
// a browser safe-area inset which is redundant inside the native SafeAreaView.
const WEBVIEW_LAYOUT_FIX = `
  (function healzLandingViewportRefresh() {
    var refresh = function () {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('orientationchange'));
    };

    var fixAuthenticatedTopInset = function () {
      // This class is only rendered by the authenticated app shell. Applying
      // the correction conditionally keeps the public landing untouched.
      document.querySelectorAll('.app-navbar').forEach(function (navbar) {
        navbar.style.paddingTop = '0px';
        Array.prototype.forEach.call(navbar.children, function (child) {
          child.style.paddingTop = '0px';
        });
      });

      // The sidebar uses the same browser-only top inset through an ancestor
      // rather than .app-navbar. Detect its language control and lift only
      // that visible sidebar container.
      var languageButton = Array.prototype.slice
        .call(document.querySelectorAll('button[aria-label="Language"]'))
        .find(function (button) {
          var rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      if (!languageButton) return;

      for (var node = languageButton.parentElement; node && node !== document.body; node = node.parentElement) {
        var classes = typeof node.className === 'string' ? node.className : '';
        var rect = node.getBoundingClientRect();
        // Healz's web sidebar reserves 52px for a browser safe area. The
        // native SafeAreaView already owns that area, so it creates the blank
        // band above the logo, language selector, and New chat action.
        if (classes.indexOf('mt-[8px]') !== -1 && rect.height < 140) {
          node.style.paddingTop = '0px';
          break;
        }
        if (classes.indexOf('justify-center') !== -1 && rect.height > 300) {
          node.style.justifyContent = 'flex-start';
          node.style.paddingTop = '0px';
          node.style.marginTop = '0px';
          break;
        }
      }
    };

    refresh();
    fixAuthenticatedTopInset();
    window.addEventListener('load', function () {
      refresh();
      fixAuthenticatedTopInset();
    }, { once: true });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        refresh();
        fixAuthenticatedTopInset();
      }).catch(function () {});
    }
    [250, 900, 1800].forEach(function (delay) {
      setTimeout(function () {
        refresh();
        fixAuthenticatedTopInset();
      }, delay);
    });

    // The sidebar mounts after its menu button is pressed, long after the
    // initial load hooks have finished. A short post-click retry is cheaper
    // than observing every DOM change for the lifetime of the WebView.
    document.addEventListener('click', function () {
      [0, 80, 240].forEach(function (delay) {
        setTimeout(fixAuthenticatedTopInset, delay);
      });
    }, true);
  })();
  true;
`;

type SharedDocument = {
  uri: string;
  name: string;
  type: string;
  size: number;
  originalSize: number;
  compressed: boolean;
  compressionRatio: number;
  base64: string;
};

type SharedDocumentBatch = {
  documents: SharedDocument[];
  count: number;
  size: number;
  originalSize: number;
  compressedCount: number;
  compressed: boolean;
  compressionRatio: number;
};

type SharedDocumentModule = {
  getPendingShare: () => Promise<SharedDocumentBatch | null>;
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

function resolveHealzDeepLink(url: string | null | undefined) {
  if (!url || !url.toLowerCase().startsWith('healz://')) {
    return null;
  }

  const route = url.slice('healz://'.length);
  return `${APP_URL}/${route}`;
}

function createAttachSharedDocumentInjection(batch: SharedDocumentBatch) {
  const payload = JSON.stringify(batch);

  return `
    (function attachSharedDocument() {
      var sharedBatch = ${payload};
      var sharedDocuments = sharedBatch.documents || [];

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
        if (sharedDocuments.length === 0) {
          report('error', 'No shared documents were received from Android.');
          return;
        }

        var transfer = new DataTransfer();

        sharedDocuments.forEach(function (sharedDocument) {
          var file = new File(
            [base64ToBytes(sharedDocument.base64)],
            sharedDocument.name,
            { type: sharedDocument.type }
          );
          transfer.items.add(file);
        });

        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        window.__healzShareAttachRequested = false;
        report(
          'attached',
          sharedDocuments.length === 1
            ? 'Shared file was passed to Healz.'
            : sharedDocuments.length + ' shared files were passed to Healz.'
        );
      };

      var tryAttach = function () {
        var input = findFileInput();
        if (input) {
          attachToInput(input);
          return;
        }

        var attachButton = findAttachControl();
        if (attachButton) {
          // A share can arrive before the chat has mounted its file input.
          // Open the picker once, then let the native shell retry without
          // repeatedly opening the system picker on every attempt.
          if (!window.__healzShareAttachRequested) {
            window.__healzShareAttachRequested = true;
            attachButton.click();
          }
          setTimeout(function () {
            var nextInput = findFileInput();
            if (nextInput) {
              attachToInput(nextInput);
              return;
            }

            window.__healzShareAttachRequested = false;
            report(
              'waiting',
              'Finish login in Healz. The shared document will attach after the chat is ready.'
            );
          }, 500);
          return;
        }

        report('waiting', 'Open a Healz chat. The shared document will attach automatically.');
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
  const pendingSharedDocumentRef = useRef<SharedDocumentBatch | null>(null);
  const isReadingShareRef = useRef(false);
  const shareReadStartedAtRef = useRef<number | null>(null);
  const shareReadTimedOutRef = useRef(false);
  const shareReadAttemptRef = useRef(0);
  const shareRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shareAttachStartedAtRef = useRef<number | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingSharedDocument, setPendingSharedDocument] = useState<SharedDocumentBatch | null>(null);
  const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [shareRetryNonce, setShareRetryNonce] = useState(0);
  const [webViewUrl, setWebViewUrl] = useState(APP_URL);

  const navigateToDeepLink = useCallback((url: string | null | undefined) => {
    const targetUrl = resolveHealzDeepLink(url);
    if (!targetUrl) {
      return false;
    }

    setLoadError(null);
    setWebViewUrl(targetUrl);
    return true;
  }, []);

  useEffect(() => {
    let mounted = true;

    Linking.getInitialURL()
      .then((url) => {
        if (mounted) {
          navigateToDeepLink(url);
        }
      })
      .catch((error) => {
        console.warn('Unable to read initial deep link', error);
      });

    const deepLinkSubscription = Linking.addEventListener('url', ({ url }) => {
      navigateToDeepLink(url);
    });

    return () => {
      mounted = false;
      deepLinkSubscription.remove();
    };
  }, [navigateToDeepLink]);

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
      Alert.alert('Could not open link', 'No compatible app is available for this link.');
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
    if (
      isReadingShareRef.current &&
      shareReadStartedAtRef.current &&
      Date.now() - shareReadStartedAtRef.current > SHARE_READ_TIMEOUT_MS &&
      !shareReadTimedOutRef.current
    ) {
      shareReadTimedOutRef.current = true;
      shareReadAttemptRef.current += 1;
      isReadingShareRef.current = false;
      shareReadStartedAtRef.current = null;
      setShareStatus(null);
      Alert.alert(
        'Could not prepare document',
        'The file provider did not respond in time. Please try sharing the file again.'
      );
      sharedDocumentModule?.clearPendingShare();
    }

    if (
      Platform.OS !== 'android' ||
      !sharedDocumentModule ||
      pendingSharedDocumentRef.current ||
      isReadingShareRef.current
    ) {
      return;
    }

    isReadingShareRef.current = true;
    const attempt = ++shareReadAttemptRef.current;
    shareReadStartedAtRef.current = Date.now();
    shareReadTimedOutRef.current = false;

    try {
      const batch = await sharedDocumentModule.getPendingShare();
      if (attempt !== shareReadAttemptRef.current || shareReadTimedOutRef.current) {
        return;
      }
      if (!batch || batch.documents.length === 0) {
        return;
      }

      setPendingSharedDocument(batch);
      const fileLabel = batch.count === 1 ? batch.documents[0].name : `${batch.count} documents`;
      const status = batch.compressed
        ? `Optimized ${fileLabel} for readability and upload speed...`
        : `Preparing ${fileLabel} for Healz...`;
      setShareStatus(status);
    } catch (error) {
      if (attempt !== shareReadAttemptRef.current || shareReadTimedOutRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Could not read shared document.';
      Alert.alert('Could not import shared document', message);
      sharedDocumentModule.clearPendingShare();
    } finally {
      if (attempt === shareReadAttemptRef.current) {
        isReadingShareRef.current = false;
        shareReadStartedAtRef.current = null;
      }
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
      if (shareRetryTimerRef.current) {
        clearTimeout(shareRetryTimerRef.current);
        shareRetryTimerRef.current = null;
      }
    };
  }, [checkPendingShare]);

  useEffect(() => {
    if (!isWebViewReady || !pendingSharedDocument) {
      return;
    }

    const fileLabel =
      pendingSharedDocument.count === 1
        ? pendingSharedDocument.documents[0].name
        : `${pendingSharedDocument.count} documents`;
    setShareStatus(`Attaching ${fileLabel} in Healz...`);
    if (!shareAttachStartedAtRef.current) {
      shareAttachStartedAtRef.current = Date.now();
    }
    if (Date.now() - shareAttachStartedAtRef.current > SHARE_ATTACH_TIMEOUT_MS) {
      setPendingSharedDocument(null);
      setShareStatus(null);
      shareAttachStartedAtRef.current = null;
      sharedDocumentModule?.clearPendingShare();
      Alert.alert('Could not attach document', 'Open a Healz chat and share the file again.');
      return;
    }
    webViewRef.current?.injectJavaScript(
      createAttachSharedDocumentInjection(pendingSharedDocument)
    );
  }, [isWebViewReady, pendingSharedDocument, shareRetryNonce]);

  const handleWebMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const message = JSON.parse(event.nativeEvent.data) as WebShareMessage;
        if (message.source !== 'healz-share-target') {
          return;
        }

        if (message.status === 'waiting') {
          setShareStatus(message.message);
          if (!shareRetryTimerRef.current) {
            shareRetryTimerRef.current = setTimeout(() => {
              shareRetryTimerRef.current = null;
              if (pendingSharedDocumentRef.current) {
                setShareRetryNonce((current) => current + 1);
              }
            }, 1200);
          }
          return;
        }

        if (shareRetryTimerRef.current) {
          clearTimeout(shareRetryTimerRef.current);
          shareRetryTimerRef.current = null;
        }

        setPendingSharedDocument(null);
        setShareStatus(null);
        shareAttachStartedAtRef.current = null;
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
      source={{ uri: webViewUrl }}
      style={styles.webview}
      onLoadStart={handleLoadStart}
      onNavigationStateChange={handleNavigationStateChange}
      onShouldStartLoadWithRequest={handleShouldStartLoad}
      onError={handleLoadError}
      onHttpError={handleHttpError}
      onMessage={handleWebMessage}
      onLoadEnd={handleLoadEnd}
      injectedJavaScript={WEBVIEW_LAYOUT_FIX}
      // Android WebView occasionally reuses stale hardware tiles on the
      // landing page, duplicating the promo banner over the composer.
      androidLayerType="software"
      javaScriptEnabled
      domStorageEnabled
      cacheEnabled
      sharedCookiesEnabled
      thirdPartyCookiesEnabled
      incognito={false}
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
