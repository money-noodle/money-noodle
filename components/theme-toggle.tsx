'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

const STORAGE_KEY = 'money-noodle-theme';

function savedOrSystemTheme(): { dark: boolean; explicitLight: boolean } {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return {
    dark: saved === 'dark' || (saved !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches),
    explicitLight: saved === 'light',
  };
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (useDark: boolean, explicitLight = false) => {
      document.documentElement.classList.toggle('dark', useDark);
      document.documentElement.classList.toggle('light', !useDark && explicitLight);
      setDark(useDark);
    };
    const initial = savedOrSystemTheme();
    apply(initial.dark, initial.explicitLight);
    // Follow operating-system changes until the operator explicitly picks light or dark.
    const onSystemThemeChange = (event: MediaQueryListEvent) => {
      if (window.localStorage.getItem(STORAGE_KEY) === null) apply(event.matches);
    };
    media.addEventListener('change', onSystemThemeChange);
    return () => media.removeEventListener('change', onSystemThemeChange);
  }, []);

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    document.documentElement.classList.toggle('light', !next);
    window.localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
    setDark(next);
  }

  return <Button variant="outline" size="icon" onClick={toggle} aria-label={dark ? 'Show light theme' : 'Show dark theme'} title={dark ? 'Show light theme' : 'Show dark theme'}>
    {dark ? <Sun/> : <Moon/>}
  </Button>;
}
