"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "zh" | "en";

type LocaleContextValue = {
  locale: Locale;
  provided: boolean;
  setLocale: (locale: Locale) => void;
};

const LocaleContext = createContext<LocaleContextValue>({
  locale: "zh",
  provided: false,
  setLocale: () => undefined,
});

const STORAGE_KEY = "musicscope.locale";

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [storedLocale, setStoredLocale] = useState<Locale | null>(null);
  const locale: Locale = storedLocale ?? "zh";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      setStoredLocale(stored === "en" || stored === "zh" ? stored : "zh");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (storedLocale === null) return;
    window.localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale, storedLocale]);

  const value = useMemo(() => ({
    locale,
    provided: true,
    setLocale: (next: Locale) => {
      window.localStorage.setItem(STORAGE_KEY, next);
      setStoredLocale(next);
    },
  }), [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}

export function useText() {
  const { locale, provided } = useLocale();
  return (english: string, chinese: string) => provided && locale === "zh" ? chinese : english;
}

export function LocaleToggle() {
  const { locale, setLocale } = useLocale();
  return <div className="locale-toggle" aria-label={locale === "zh" ? "语言" : "Language"}>
    <button type="button" aria-pressed={locale === "zh"} onClick={() => setLocale("zh")}>中文</button>
    <button type="button" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>EN</button>
  </div>;
}
