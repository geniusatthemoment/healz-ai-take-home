import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  Linking,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewNavigation,
} from 'react-native-webview/lib/WebViewTypes';

const APP_URL = 'https://app.healz.ai';
const INTERNAL_HOSTS = new Set(['app.healz.ai', 'healz.ai', 'www.healz.ai']);

function isInternalUrl(url: string) {
  try {
    const parsed = new URL(url);
    return INTERNAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export default function App() {
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(APP_URL);
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
    setCurrentUrl(state.url);
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

      if (isInternalUrl(url)) {
        return true;
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

  const handleRetry = useCallback(() => {
    setLoadError(null);
    webViewRef.current?.reload();
  }, []);

  const handleOpenInBrowser = useCallback(() => {
    openExternalUrl(currentUrl || APP_URL);
  }, [currentUrl, openExternalUrl]);

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
      javaScriptEnabled
      domStorageEnabled
      cacheEnabled
      sharedCookiesEnabled
      thirdPartyCookiesEnabled
      allowsBackForwardNavigationGestures
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
    backgroundColor: '#f5f1e8',
  },
  container: {
    flex: 1,
    backgroundColor: '#f5f1e8',
  },
  webview: {
    flex: 1,
    backgroundColor: '#f5f1e8',
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f1e8',
  },
  errorCard: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#f5f1e8',
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
    color: '#f5f1e8',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#122033',
    paddingVertical: 14,
  },
  secondaryButtonText: {
    color: '#122033',
    fontSize: 16,
    fontWeight: '600',
  },
});
