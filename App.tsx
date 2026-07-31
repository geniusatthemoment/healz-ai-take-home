import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Linking,
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
  WebViewNavigation,
} from 'react-native-webview/lib/WebViewTypes';

const APP_URL = 'https://app.healz.ai';
const INTERNAL_HOSTS = new Set(['app.healz.ai', 'healz.ai', 'www.healz.ai']);
const MOBILE_CHROME_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

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

export default function App() {
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

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
        <View style={styles.container}>{webView}</View>
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
