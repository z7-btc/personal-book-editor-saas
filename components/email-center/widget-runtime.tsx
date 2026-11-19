'use client';

import { useEffect } from 'react';
import type { Locale } from '@/i18n/routing';

type LoadedWidget = { script: HTMLScriptElement; src: string; widgetKey: string; locale: Locale };

let mountedWidgets = 0;
let loadedWidget: LoadedWidget | null = null;
let pendingCleanup: number | null = null;

function removeWidgetRoot(script: HTMLScriptElement) {
  const id = script.dataset.widgetRootId;
  if (id) document.getElementById(id)?.remove();
}

function unloadWidget() {
  if (!loadedWidget) return;
  loadedWidget.script.remove();
  removeWidgetRoot(loadedWidget.script);
  loadedWidget = null;
}

export function WidgetRuntime({ src, widgetKey, locale }: {
  src: string; widgetKey: string; locale: Locale;
}) {
  useEffect(() => {
    mountedWidgets++;
    if (pendingCleanup !== null) {
      window.clearTimeout(pendingCleanup);
      pendingCleanup = null;
    }
    if (!loadedWidget || loadedWidget.src !== src || loadedWidget.widgetKey !== widgetKey ||
        loadedWidget.locale !== locale) {
      unloadWidget();
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.appKey = widgetKey;
      script.dataset.productName = 'SaaS Framework';
      // Without this the Widget reads `navigator.language` and a visitor whose
      // browser is set to Chinese keeps a Chinese form on the English site.
      // Passing the locale pins the Widget to the language of the page it is
      // embedded in; switching language re-runs this effect and remounts it.
      script.dataset.locale = locale;
      // The widget opens itself on arrival, matching how the sibling property
      // runs it: a visitor's first look at the landing page is exactly when a
      // subscribe prompt earns its place, and the widget owns its own
      // dismissal and frequency capping.
      script.dataset.open = 'true';
      script.addEventListener('load', () => {
        if (loadedWidget?.script !== script) removeWidgetRoot(script);
      });
      loadedWidget = { script, src, widgetKey, locale };
      document.body.appendChild(script);
    }

    return () => {
      mountedWidgets--;
      if (mountedWidgets === 0) {
        pendingCleanup = window.setTimeout(() => {
          pendingCleanup = null;
          if (mountedWidgets === 0) unloadWidget();
        }, 0);
      }
    };
  }, [src, widgetKey, locale]);

  return null;
}
