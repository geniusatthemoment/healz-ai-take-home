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
  ScrollView,
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
const SHOW_CHAT_REFRESH = false;
const INTERNAL_HOSTS = new Set(['app.healz.ai', 'healz.ai', 'www.healz.ai']);
const MOBILE_CHROME_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

// The landing page calculates a different responsive layout after the first
// viewport change (for example, when the keyboard opens). Keep this to one
// coalesced recalculation so the WebView does not repeatedly invalidate its
// entire document while it is hydrating. Authenticated Healz screens
// additionally carry a browser safe-area inset which is redundant inside the
// native SafeAreaView.
const WEBVIEW_LAYOUT_FIX = `
  (function healzLandingViewportRefresh() {
    var refreshTimer = null;
    var scheduleRefresh = function (delay) {
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(function () {
        refreshTimer = null;
        window.dispatchEvent(new Event('resize'));
        fixAuthenticatedTopInset();
      }, delay || 0);
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

    scheduleRefresh(0);
    fixAuthenticatedTopInset();
    window.addEventListener('load', function () {
      scheduleRefresh(120);
    }, { once: true });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        scheduleRefresh(120);
      }).catch(function () {});
    }

    // The sidebar mounts after its menu button is pressed, long after the
    // initial load hooks have finished. Coalesce rapid taps into one delayed
    // check instead of forcing three DOM scans after every click on the page.
    var clickFixTimer = null;
    document.addEventListener('click', function () {
      if (clickFixTimer !== null) {
        clearTimeout(clickFixTimer);
      }
      clickFixTimer = setTimeout(function () {
        clickFixTimer = null;
        fixAuthenticatedTopInset();
      }, 160);
    }, true);

    // Backdrop blur on a sticky element creates a large GPU surface in
    // Android WebView. Keep the same opaque visual treatment without asking
    // the compositor to blur the complete page behind the navbar.
    document.querySelectorAll('nav').forEach(function (navbar) {
      var style = window.getComputedStyle(navbar);
      if (style.position === 'sticky' && style.backdropFilter !== 'none') {
        navbar.style.backdropFilter = 'none';
        navbar.style.webkitBackdropFilter = 'none';
        navbar.style.backgroundColor = 'rgba(255, 255, 255, 0.96)';
      }
    });
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
  invalidateWebView?: () => void;
  installWebViewRedrawHooks?: () => void;
  rebuildWebViewLayer?: () => void;
};

type WebShareMessage = {
  source: 'healz-share-target';
  status: 'attached' | 'waiting' | 'error' | 'chats' | 'chat-selected' | 'vault-selected';
  message: string;
  chats?: ChatOption[];
};

type ChatOption = {
  key: string;
  title: string;
};

const sharedDocumentModule = NativeModules.SharedDocument as SharedDocumentModule | undefined;

const REQUEST_CHAT_LIST_INJECTION = `
  (function requestHealzChatList() {
    var visible = function (element) {
      var rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
    };
    var cleanTitle = function (element) {
      return (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, 80);
    };
    var isExcluded = function (title) {
      return /new chat|new case|attach|upload|file|secure file vault|menu|language|settings|logout|sign out|try healz|pricing|privacy|terms|upgrade to plus|unlimited chats|anonymous|subscription|account|profile|@|^healz(?: ai)?(?: en)?$|^usen$|^(older|today|yesterday|previous)/i.test(title);
    };
    var isChatRow = function (element) {
      var rect = element.getBoundingClientRect();
      var inDrawer = !!element.closest('[role="dialog"], aside, [class*="sidebar" i], [data-sidebar]');
      var hasRowAction = !!element.querySelector(':scope > button, :scope > [role="button"]');
      var directTitles = Array.prototype.slice.call(element.children)
        .map(cleanTitle)
        .filter(Boolean);
      return inDrawer && hasRowAction && directTitles.length === 1 &&
        cleanTitle(element) === directTitles[0] && rect.height >= 36 && rect.height <= 160;
    };
    var scan = function () {
      var candidates = Array.prototype.slice.call(document.querySelectorAll(
        'aside a[href], aside button, aside [role="button"], aside [tabindex], ' +
        'nav a[href], nav button, nav [role="button"], nav [tabindex], ' +
        '[role="navigation"] a[href], [role="navigation"] button, ' +
        '[role="navigation"] [role="button"], [role="navigation"] [tabindex], ' +
        '[data-testid*="chat" i], [data-testid*="conversation" i], ' +
        '[class*="chat-item" i], [class*="chat-list" i], [class*="conversation" i], ' +
        '[class*="thread" i], ' +
        '[role="dialog"] div, [role="dialog"] li, ' +
        'a[href], button:not([disabled]), [role="button"], [tabindex]'
      ));
      var chats = [];
      var seen = {};

      candidates.forEach(function (candidate, index) {
        var title = cleanTitle(candidate);
        var href = candidate.href || candidate.getAttribute('href') || '';
        var inSidebar = !!candidate.closest('aside, nav, [role="navigation"], [role="dialog"], [class*="sidebar" i], [data-sidebar]');
        var looksLikeChatUrl = /\\/(chat|chats|conversation|conversations|case|cases|thread|threads)([/?#]|$)/i.test(href);
        var looksLikeChatItem = /chat-item|conversation|chat-list|thread/i.test(candidate.getAttribute('class') || '') ||
          /chat|conversation|thread/i.test(candidate.getAttribute('data-testid') || '') ||
          isChatRow(candidate);
        if (!visible(candidate) && !inSidebar && !looksLikeChatUrl && !looksLikeChatItem) return;
        if (!title || isExcluded(title) || (!inSidebar && !looksLikeChatUrl && !looksLikeChatItem)) return;
        if (href && (!/^https?:/i.test(href) || href.indexOf(location.origin) !== 0)) return;
        if (href && /\\/(login|signup|settings|privacy|terms)([/?#]|$)/i.test(href)) return;

        var key = href || 'dom-chat::' + title.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        candidate.setAttribute('data-healz-share-chat-key', key);
        chats.push({ key: key, title: title });
      });

      window.ReactNativeWebView.postMessage(JSON.stringify({
        source: 'healz-share-target',
        status: 'chats',
        message: 'Chat list is ready.',
        chats: chats.slice(0, 30)
      }));
      return chats.length;
    };

    var findMenuButton = function () {
      var controls = Array.prototype.slice.call(document.querySelectorAll(
        'button:not([disabled]), [role="button"], [aria-label], [data-testid]'
      ));
      return controls.find(function (element) {
        if (!visible(element) || element.closest('[role="dialog"]')) return false;
        var text = [
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.getAttribute('data-testid'),
          element.getAttribute('class')
        ].filter(Boolean).join(' ');
        if (/menu|sidebar|navigation|open chats|hamburger/i.test(text)) return true;
        var rect = element.getBoundingClientRect();
        return !!element.querySelector('svg') && rect.width < 72 && rect.height < 72 && rect.left < 100;
      });
    };
    var closeHiddenDrawer = function (drawer) {
      var buttons = Array.prototype.slice.call(drawer.querySelectorAll('button'));
      var close = buttons.find(function (button) {
        var label = [button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' ');
        var rect = button.getBoundingClientRect();
        return /close/i.test(label) || (rect.top < 140 && rect.right > window.innerWidth * 0.85);
      });
      if (close) close.click();
    };
    var scanHiddenDrawer = function () {
      var menu = findMenuButton();
      if (!menu) return;
      var observer = new MutationObserver(function () {
        var drawer = document.querySelector('[role="dialog"]');
        if (!drawer) return;
        drawer.style.visibility = 'hidden';
        observer.disconnect();
        setTimeout(function () {
          scan();
          closeHiddenDrawer(drawer);
        }, 0);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      menu.click();
      setTimeout(function () { observer.disconnect(); }, 1500);
    };

    // Healz unmounts the mobile drawer when it closes, so its chat rows cannot
    // be read directly. If the first scan is empty, mount the drawer hidden,
    // read the rows, and close it before the WebView can paint it.
    if (!scan()) scanHiddenDrawer();
    setTimeout(function () {
      if (!scan()) scanHiddenDrawer();
    }, 350);
  })();
  true;
`;

function createSelectChatInjection(chatKey: string) {
  return `
    (function selectHealzChat() {
      var key = ${JSON.stringify(chatKey)};
      var cleanTitle = function (element) {
        return (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '')
          .replace(/\\s+/g, ' ')
          .trim()
          .slice(0, 80);
      };
      var tagChatRows = function () {
        Array.prototype.slice.call(document.querySelectorAll('[role="dialog"] div, [role="dialog"] li'))
          .forEach(function (element) {
            var rect = element.getBoundingClientRect();
            var hasRowAction = !!element.querySelector(':scope > button, :scope > [role="button"]');
            var title = cleanTitle(element);
            var directTitles = Array.prototype.slice.call(element.children)
              .map(cleanTitle)
              .filter(Boolean);
            if (hasRowAction && directTitles.length === 1 && title === directTitles[0] &&
                rect.height >= 36 && rect.height <= 160 && title) {
              element.setAttribute('data-healz-share-chat-key', 'dom-chat::' + title.toLowerCase());
            }
          });
      };
      var findTarget = function () {
        tagChatRows();
        return Array.prototype.slice.call(
          document.querySelectorAll('[data-healz-share-chat-key]')
        ).find(function (element) {
          return element.getAttribute('data-healz-share-chat-key') === key;
        });
      };
      var target = findTarget();

      if (!target) {
        if (/^https?:/i.test(key) && key.indexOf(location.origin) === 0) {
          location.href = key;
          setTimeout(function () {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              source: 'healz-share-target',
              status: 'chat-selected',
              message: 'The selected chat is opening.'
            }));
          }, 900);
          return true;
        }
        var controls = Array.prototype.slice.call(document.querySelectorAll(
          'button:not([disabled]), [role="button"], [aria-label], [data-testid]'
        ));
        var menu = controls.find(function (element) {
          if (element.closest('[role="dialog"]')) return false;
          var rect = element.getBoundingClientRect();
          if (!(rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight)) return false;
          var text = [
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.getAttribute('data-testid'),
            element.getAttribute('class')
          ].filter(Boolean).join(' ');
          if (/menu|sidebar|navigation|open chats|hamburger/i.test(text)) return true;
          return !!element.querySelector('svg') && rect.width < 72 && rect.height < 72 && rect.left < 100;
        });
        if (!menu) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            source: 'healz-share-target',
            status: 'error',
            message: 'The selected chat is no longer available.'
          }));
          return true;
        }

        var observer = new MutationObserver(function () {
          var drawer = document.querySelector('[role="dialog"]');
          if (!drawer) return;
          drawer.style.visibility = 'hidden';
          tagChatRows();
          target = findTarget();
          if (!target) return;
          observer.disconnect();
          target.click();
          setTimeout(function () {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              source: 'healz-share-target',
              status: 'chat-selected',
              message: 'The selected chat is opening.'
            }));
          }, 700);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        menu.click();
        setTimeout(function () {
          observer.disconnect();
          if (!target) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              source: 'healz-share-target',
              status: 'error',
              message: 'The selected chat could not be opened.'
            }));
          }
        }, 1800);
        return true;
      }

      target.click();
      var startedAt = Date.now();
      var confirmSelection = function () {
        var currentTarget = Array.prototype.slice.call(
          document.querySelectorAll('[data-healz-share-chat-key]')
        ).find(function (element) {
          return element.getAttribute('data-healz-share-chat-key') === key;
        });
        var classes = currentTarget && typeof currentTarget.className === 'string'
          ? currentTarget.className
          : '';
        var selected = !currentTarget || location.href === key || (currentTarget && (
          currentTarget.getAttribute('aria-current') === 'page' ||
          currentTarget.getAttribute('data-state') === 'active' ||
          /(^|\\s)(active|selected)(\\s|$)/i.test(classes)
        ));

        if (selected || Date.now() - startedAt >= 5000) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            source: 'healz-share-target',
            status: selected ? 'chat-selected' : 'error',
            message: selected
              ? 'The selected chat is opening.'
              : 'The selected chat did not finish opening.'
          }));
          return;
        }
        setTimeout(confirmSelection, 250);
      };
      setTimeout(confirmSelection, 250);
    })();
    true;
  `;
}

const CREATE_NEW_CHAT_INJECTION = `
  (function createHealzChat() {
    var visible = function (element) {
      var rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
    };
    var describe = function (element) {
      return [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.textContent
      ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
    };
    var findExplicitTarget = function () {
      var controls = Array.prototype.slice.call(document.querySelectorAll(
        'button:not([disabled]), a, [role="button"], [tabindex], [aria-label], [data-testid]'
      ));
      return controls.find(function (element) {
        if (!visible(element)) return false;
        return /^(new chat|new case|start (a )?chat|new conversation|create chat|compose)$/i.test(describe(element));
      });
    };
    var findGlobalNewChatButton = function () {
      var buttons = Array.prototype.slice.call(document.querySelectorAll('button:not([disabled])'));
      return buttons.find(function (button) {
        if (!visible(button) || button.closest('[role="dialog"]')) return false;
        var rect = button.getBoundingClientRect();
        var text = describe(button);
        var looksLikeNewChat = /new chat|new case|create chat|compose|add chat/i.test(text);
        var isHeaderAction = rect.top < 190 && rect.right > window.innerWidth * 0.82 &&
          rect.width >= 28 && rect.width <= 90 && rect.height >= 28 && rect.height <= 90;
        return looksLikeNewChat || (isHeaderAction && !!button.querySelector('svg'));
      });
    };
    var findMenuButton = function () {
      var controls = Array.prototype.slice.call(document.querySelectorAll(
        'button:not([disabled]), [role="button"], [aria-label], [data-testid]'
      ));
      return controls.find(function (element) {
        if (!visible(element) || element.closest('[role="dialog"]')) return false;
        var text = describe(element);
        if (/menu|sidebar|navigation|open chats|hamburger/i.test(text)) return true;
        var rect = element.getBoundingClientRect();
        return !!element.querySelector('svg') && rect.width < 72 && rect.height < 72 && rect.left < 100;
      });
    };
    var report = function (status, message) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        source: 'healz-share-target',
        status: status,
        message: message
      }));
    };
    var finished = false;
    var finish = function (target) {
      if (finished) return;
      finished = true;
      target.click();
      setTimeout(function () {
        report('chat-selected', 'A new chat is opening.');
      }, 800);
    };

    var directTarget = findExplicitTarget() || findGlobalNewChatButton();
    if (directTarget) {
      finish(directTarget);
      return true;
    }

    // Some Healz tabs only expose New chat inside the mobile drawer. Mount it
    // invisibly behind the native picker, click the exact row, and let React
    // unmount it as the new conversation opens.
    var menu = findMenuButton();
    if (!menu) {
      report('error', 'Could not find the New chat action in Healz.');
      return true;
    }
    var observer = new MutationObserver(function () {
      var drawer = document.querySelector('[role="dialog"]');
      if (!drawer) return;
      drawer.style.visibility = 'hidden';
      var elements = Array.prototype.slice.call(drawer.querySelectorAll('button, a, [role="button"], div'));
      var target = elements.find(function (element) {
        return /^new chat$/i.test(describe(element));
      });
      if (!target) return;
      observer.disconnect();
      finish(target);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    menu.click();
    setTimeout(function () {
      if (finished) return;
      observer.disconnect();
      var drawer = document.querySelector('[role="dialog"]');
      var elements = drawer
        ? Array.prototype.slice.call(drawer.querySelectorAll('button, a, [role="button"], div'))
        : [];
      var target = elements.find(function (element) {
        return /^new chat$/i.test(describe(element));
      });
      if (target) {
        finish(target);
      } else {
        report('error', 'Could not find the New chat action in Healz.');
      }
    }, 1200);
  })();
  true;
`;

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

function createAttachSharedDocumentInjection(
  batch: SharedDocumentBatch,
  destination: 'chat' | 'vault'
) {
  const payload = JSON.stringify(batch);

  return `
    (function attachSharedDocument() {
      var sharedBatch = ${payload};
      var destination = ${JSON.stringify(destination)};
      var sharedDocuments = sharedBatch.documents || [];
      var batchKey = sharedDocuments.map(function (document) {
        return [document.uri, document.name, document.size].join('|');
      }).join('||');

      var report = function (status, message) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          source: 'healz-share-target',
          status: status,
          message: message
        }));
      };

      var findFileInput = function () {
        var inputs = Array.prototype.slice.call(
          document.querySelectorAll('input[type="file"]:not([disabled])')
        ).filter(function (input) {
          return input.isConnected && !input.closest('[aria-hidden="true"]');
        });

        // Healz can keep file inputs from inactive UI branches in the DOM.
        // Prefer the one whose surrounding composer is actually on screen.
        var score = function (input) {
          var points = 0;
          for (var node = input.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
            var rect = node.getBoundingClientRect();
            if (rect.width > 80 && rect.height > 20 && rect.bottom > 0 && rect.top < window.innerHeight) {
              points += 10;
            }
          }
          return points;
        };

        return inputs.sort(function (left, right) {
          return score(right) - score(left);
        })[0] || null;
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

      var createSharedFile = function (sharedDocument) {
        return new File(
          [base64ToBytes(sharedDocument.base64)],
          sharedDocument.name,
          { type: sharedDocument.type }
        );
      };

      var attachToInput = function (input, finish) {
        if (sharedDocuments.length === 0) {
          finish('error', 'No shared documents were received from Android.');
          return;
        }

        var transfer = new DataTransfer();

        sharedDocuments.forEach(function (sharedDocument) {
          transfer.items.add(createSharedFile(sharedDocument));
        });

        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };

      var activeBatchKey = destination + '::' + batchKey;
      if (window.__healzShareActiveBatch === activeBatchKey) {
        // The native layer retries while Healz hydrates. The original bridge
        // remains responsible for reporting its eventual result.
        return true;
      }
      if (window.__healzShareCompletedBatch === activeBatchKey) {
        report('attached', 'Shared file was already passed to Healz.');
        return true;
      }
      window.__healzShareActiveBatch = activeBatchKey;

      var startedAt = Date.now();
      var deadlineMs = destination === 'vault' ? 120000 : 12000;
      var pickerOpened = false;
      var completed = false;
      var vaultUploadStarted = false;
      var finish = function (status, message) {
        if (completed) return;
        completed = true;
        if (status === 'attached') {
          window.__healzShareCompletedBatch = activeBatchKey;
        }
        window.__healzShareActiveBatch = null;
        window.__healzShareAttachRequested = false;
        report(status, message);
      };

      var uploadDirectlyToVault = function () {
        if (vaultUploadStarted || completed) return;
        if (sharedDocuments.length === 0) {
          finish('error', 'No shared documents were received from Android.');
          return;
        }
        vaultUploadStarted = true;

        Promise.all(sharedDocuments.map(function (sharedDocument) {
          var formData = new FormData();
          formData.append('file', createSharedFile(sharedDocument));
          return window.fetch('/api/documents', {
            method: 'POST',
            body: formData,
            credentials: 'same-origin'
          });
        })).then(function (responses) {
          var failedResponse = responses.find(function (response) {
            return !response.ok;
          });
          if (failedResponse) {
            finish(
              'error',
              'Secure File Vault rejected the shared document (HTTP ' + failedResponse.status + ').'
            );
            return;
          }
          finish(
            'attached',
            sharedDocuments.length === 1
              ? 'Shared file was saved to Secure File Vault.'
              : sharedDocuments.length + ' shared files were saved to Secure File Vault.'
          );
          setTimeout(function () {
            window.location.reload();
          }, 500);
        }).catch(function () {
          finish('error', 'Could not save the shared document to Secure File Vault.');
        });
      };

      var tryAttach = function () {
        if (completed) return;
        if (destination === 'vault') {
          uploadDirectlyToVault();
          return;
        }
        var input = findFileInput();
        if (input) {
          try {
            attachToInput(input, finish);
            // Dispatching a change is asynchronous from the site's point of
            // view. Confirm that the active input retained all files before
            // native code clears its durable pending-share record.
            setTimeout(function () {
              if (input.isConnected && input.files && input.files.length === sharedDocuments.length) {
                finish(
                  'attached',
                  sharedDocuments.length === 1
                    ? 'Shared file was passed to Healz.'
                    : sharedDocuments.length + ' shared files were passed to Healz.'
                );
                return;
              }
              poll();
            }, 0);
          } catch (error) {
            poll();
          }
          return;
        }

        // Let the chat hydrate first. Opening a file picker immediately after
        // an Android share intent races with the incoming attachment.
        if (Date.now() - startedAt >= 1800 && !pickerOpened) {
          var attachButton = findAttachControl();
          if (!window.__healzShareAttachRequested) {
            window.__healzShareAttachRequested = true;
            pickerOpened = true;
            attachButton && attachButton.click();
          }
        }

        poll();
      };

      var poll = function () {
        if (completed) return;
        if (Date.now() - startedAt >= deadlineMs) {
          finish(
            destination === 'vault' ? 'error' : 'waiting',
            destination === 'vault'
              ? 'Could not find the Secure File Vault uploader. Please try again.'
              : 'Open a Healz chat. The shared document will attach automatically.'
          );
          return;
        }
        setTimeout(tryAttach, 250);
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
  const chatListRequestKeyRef = useRef<string | null>(null);
  const attachRequestedRef = useRef(false);
  const attachmentDestinationRef = useRef<'chat' | 'vault'>('chat');
  const [canGoBack, setCanGoBack] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingSharedDocument, setPendingSharedDocument] = useState<SharedDocumentBatch | null>(null);
  const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [shareRetryNonce, setShareRetryNonce] = useState(0);
  const [chatOptions, setChatOptions] = useState<ChatOption[]>([]);
  const [isChatPickerVisible, setIsChatPickerVisible] = useState(false);
  const [isChatPickerLoading, setIsChatPickerLoading] = useState(false);
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
  }, []);

  const handleLoadEnd = useCallback(() => {
    setIsWebViewReady(true);
    if (Platform.OS === 'android') {
      sharedDocumentModule?.installWebViewRedrawHooks?.();
      sharedDocumentModule?.rebuildWebViewLayer?.();
      sharedDocumentModule?.invalidateWebView?.();
    }
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

      chatListRequestKeyRef.current = null;
      attachRequestedRef.current = false;
      attachmentDestinationRef.current = 'chat';
      setChatOptions([]);
      setIsChatPickerLoading(true);
      setIsChatPickerVisible(true);
      setPendingSharedDocument(batch);
      setShareStatus(null);
      webViewRef.current?.injectJavaScript(
        'window.__healzShareCompletedBatch = null; true;'
      );
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
    if (!pendingSharedDocument || !isChatPickerVisible) {
      return;
    }

    if (!isWebViewReady) {
      setIsChatPickerLoading(true);
      return;
    }

    const requestKey = pendingSharedDocument.documents
      .map((document) => [document.uri, document.size].join('|'))
      .join('||');
    if (chatListRequestKeyRef.current === requestKey) {
      return;
    }

    chatListRequestKeyRef.current = requestKey;
    setIsChatPickerLoading(true);
    webViewRef.current?.injectJavaScript(REQUEST_CHAT_LIST_INJECTION);
  }, [isChatPickerVisible, isWebViewReady, pendingSharedDocument, shareRetryNonce]);

  const handleCancelChatPicker = useCallback(() => {
    setIsChatPickerVisible(false);
    setIsChatPickerLoading(false);
    setChatOptions([]);
    setPendingSharedDocument(null);
    setShareStatus(null);
    shareAttachStartedAtRef.current = null;
    chatListRequestKeyRef.current = null;
    attachRequestedRef.current = false;
    attachmentDestinationRef.current = 'chat';
    sharedDocumentModule?.clearPendingShare();
  }, []);

  const handleRetryChatList = useCallback(() => {
    chatListRequestKeyRef.current = null;
    setIsChatPickerLoading(true);
    setShareRetryNonce((current) => current + 1);
  }, []);

  const handleSelectChat = useCallback((chat: ChatOption) => {
    attachmentDestinationRef.current = 'chat';
    setIsChatPickerLoading(true);
    setShareStatus(`Opening ${chat.title}...`);
    webViewRef.current?.injectJavaScript(createSelectChatInjection(chat.key));
  }, []);

  const handleCreateNewChat = useCallback(() => {
    attachmentDestinationRef.current = 'chat';
    setIsChatPickerLoading(true);
    setShareStatus('Opening a new Healz chat...');
    webViewRef.current?.injectJavaScript(CREATE_NEW_CHAT_INJECTION);
  }, []);

  const handleOpenSecureVault = useCallback(() => {
    attachmentDestinationRef.current = 'vault';
    attachRequestedRef.current = true;
    setIsChatPickerVisible(false);
    setShareStatus('Preparing the file for Secure File Vault...');
    setShareRetryNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    checkPendingShare();
    const interval = setInterval(checkPendingShare, 1200);

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        checkPendingShare();
        if (Platform.OS === 'android') {
          sharedDocumentModule?.installWebViewRedrawHooks?.();
          sharedDocumentModule?.rebuildWebViewLayer?.();
          sharedDocumentModule?.invalidateWebView?.();
        }
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
    if (!pendingSharedDocument || !attachRequestedRef.current) {
      return;
    }

    const fileLabel =
      pendingSharedDocument.count === 1
        ? pendingSharedDocument.documents[0].name
        : `${pendingSharedDocument.count} documents`;
    if (!shareAttachStartedAtRef.current) {
      shareAttachStartedAtRef.current = Date.now();
    }
    const attachTimeoutMs =
      attachmentDestinationRef.current === 'vault' ? 150_000 : SHARE_ATTACH_TIMEOUT_MS;
    if (Date.now() - shareAttachStartedAtRef.current > attachTimeoutMs) {
      setIsChatPickerVisible(false);
      setPendingSharedDocument(null);
      setShareStatus(null);
      shareAttachStartedAtRef.current = null;
      attachRequestedRef.current = false;
      sharedDocumentModule?.clearPendingShare();
      Alert.alert('Could not attach document', 'The chat took too long to open. Please share the file again.');
      return;
    }

    // onLoadEnd reports document loading, whereas the selected Healz chat
    // hydrates a little later. Keep the durable share pending and retry the
    // bridge while that happens, rather than losing the file.
    if (!isWebViewReady) {
      setShareStatus(`Opening Healz to attach ${fileLabel}...`);
      const retry = setTimeout(() => {
        setShareRetryNonce((current) => current + 1);
      }, 800);
      return () => clearTimeout(retry);
    }

    setShareStatus(
      attachmentDestinationRef.current === 'vault'
        ? `Saving ${fileLabel} to Secure File Vault...`
        : `Attaching ${fileLabel} in this chat...`
    );
    webViewRef.current?.injectJavaScript(
      createAttachSharedDocumentInjection(
        pendingSharedDocument,
        attachmentDestinationRef.current
      )
    );

    // A page can replace the file input while its React tree hydrates without
    // posting a message. Retry from native code so that case cannot strand a
    // shared document indefinitely.
    const retry = setTimeout(() => {
      if (pendingSharedDocumentRef.current) {
        setShareRetryNonce((current) => current + 1);
      }
    }, 1500);
    return () => clearTimeout(retry);
  }, [isWebViewReady, pendingSharedDocument, shareRetryNonce]);

  const handleWebMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const message = JSON.parse(event.nativeEvent.data) as WebShareMessage;
        if (message.source !== 'healz-share-target') {
          return;
        }

        if (message.status === 'chats') {
          setChatOptions(message.chats ?? []);
          setIsChatPickerLoading(false);
          return;
        }

        if (message.status === 'chat-selected') {
          attachmentDestinationRef.current = 'chat';
          attachRequestedRef.current = true;
          setIsChatPickerVisible(false);
          setShareStatus('Preparing the file for this chat...');
          setShareRetryNonce((current) => current + 1);
          return;
        }

        if (message.status === 'vault-selected') {
          attachmentDestinationRef.current = 'vault';
          attachRequestedRef.current = true;
          setIsChatPickerVisible(false);
          setShareStatus('Preparing the file for Secure File Vault...');
          setShareRetryNonce((current) => current + 1);
          return;
        }

        if (message.status === 'error' && !attachRequestedRef.current) {
          setIsChatPickerVisible(true);
          setIsChatPickerLoading(false);
          setShareStatus(null);
          Alert.alert('Could not choose a destination', message.message);
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

        setIsChatPickerVisible(false);
        setPendingSharedDocument(null);
        setShareStatus(null);
        shareAttachStartedAtRef.current = null;
        attachRequestedRef.current = false;
        attachmentDestinationRef.current = 'chat';
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
          {isChatPickerVisible && pendingSharedDocument && (
            <View style={styles.chatPickerOverlay}>
              <View style={styles.chatPickerCard}>
                <Text style={styles.chatPickerEyebrow}>FILE READY</Text>
                <Text style={styles.chatPickerTitle}>Where should we send it?</Text>
                <Text style={styles.chatPickerDescription}>
                  Choose a Healz chat for {pendingSharedDocument.count === 1
                    ? pendingSharedDocument.documents[0].name
                    : `${pendingSharedDocument.count} files`}.
                </Text>

                {isChatPickerLoading ? (
                  <View style={styles.chatPickerLoading}>
                    <ActivityIndicator size="small" color="#122033" />
                    <Text style={styles.chatPickerLoadingText}>Loading your chats...</Text>
                  </View>
                ) : (
                  <ScrollView
                    style={styles.chatList}
                    contentContainerStyle={styles.chatListContent}
                    showsVerticalScrollIndicator={false}
                  >
                    {chatOptions.map((chat) => (
                      <Pressable
                        key={chat.key}
                        style={styles.chatOption}
                        onPress={() => handleSelectChat(chat)}
                      >
                        <View style={styles.chatOptionIcon}>
                          <Text style={styles.chatOptionIconText}>↗</Text>
                        </View>
                        <Text style={styles.chatOptionText} numberOfLines={2}>
                          {chat.title}
                        </Text>
                      </Pressable>
                    ))}

                    {chatOptions.length === 0 && (
                      <Text style={styles.chatEmptyText}>
                        No existing chats were found. You can start a new one.
                      </Text>
                    )}

                    <Pressable style={styles.vaultButton} onPress={handleOpenSecureVault}>
                      <View style={styles.vaultButtonIcon}>
                        <Text style={styles.vaultButtonIconText}>▣</Text>
                      </View>
                      <View style={styles.vaultButtonCopy}>
                        <Text style={styles.vaultButtonTitle}>Secure File Vault</Text>
                        <Text style={styles.vaultButtonSubtitle}>Save without adding to a chat</Text>
                      </View>
                    </Pressable>

                    <Pressable style={styles.newChatButton} onPress={handleCreateNewChat}>
                      <Text style={styles.newChatButtonText}>＋ New chat</Text>
                    </Pressable>
                  </ScrollView>
                )}

                {SHOW_CHAT_REFRESH && !isChatPickerLoading && (
                  <Pressable style={styles.retryChatButton} onPress={handleRetryChatList}>
                    <Text style={styles.retryChatButtonText}>Refresh chat list</Text>
                  </Pressable>
                )}
                <Pressable style={styles.cancelChatButton} onPress={handleCancelChatPicker}>
                  <Text style={styles.cancelChatButtonText}>Cancel</Text>
                </Pressable>
              </View>
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
  chatPickerOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(18, 32, 51, 0.38)',
  },
  chatPickerCard: {
    maxHeight: '82%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: '#ffffff',
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 16,
    shadowColor: '#122033',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.2,
    shadowRadius: 18,
    elevation: 14,
  },
  chatPickerEyebrow: {
    color: '#8b6d78',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  chatPickerTitle: {
    marginTop: 6,
    color: '#122033',
    fontSize: 26,
    fontWeight: '800',
  },
  chatPickerDescription: {
    marginTop: 8,
    color: '#5c6570',
    fontSize: 14,
    lineHeight: 20,
  },
  chatPickerLoading: {
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  chatPickerLoadingText: {
    color: '#5c6570',
    fontSize: 14,
  },
  chatList: {
    marginTop: 14,
    maxHeight: 300,
  },
  chatListContent: {
    gap: 8,
    paddingBottom: 8,
  },
  chatOption: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    backgroundColor: '#f7f3f4',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  chatOptionIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: '#2f2530',
  },
  chatOptionIconText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  chatOptionText: {
    flex: 1,
    color: '#2f2530',
    fontSize: 15,
    fontWeight: '700',
  },
  chatEmptyText: {
    paddingVertical: 16,
    color: '#5c6570',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  vaultButton: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: '#eadde2',
    borderRadius: 16,
    backgroundColor: '#fff9fb',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  vaultButtonIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#f0d9e2',
  },
  vaultButtonIconText: {
    color: '#6d5260',
    fontSize: 18,
    fontWeight: '800',
  },
  vaultButtonCopy: {
    flex: 1,
  },
  vaultButtonTitle: {
    color: '#2f2530',
    fontSize: 15,
    fontWeight: '800',
  },
  vaultButtonSubtitle: {
    marginTop: 2,
    color: '#7a7076',
    fontSize: 12,
  },
  newChatButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: '#c5ff00',
  },
  newChatButtonText: {
    color: '#122033',
    fontSize: 16,
    fontWeight: '800',
  },
  retryChatButton: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  retryChatButtonText: {
    color: '#6d5260',
    fontSize: 13,
    fontWeight: '700',
  },
  cancelChatButton: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  cancelChatButtonText: {
    color: '#8a8f96',
    fontSize: 14,
    fontWeight: '600',
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
