'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

const STORAGE_KEY = 'money-noodle-theme';

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    const useDark = saved === 'dark';
    document.documentElement.classList.toggle('dark', useDark);
    setDark(useDark);
  }, []);

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    window.localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
    setDark(next);
  }

  return <Button variant="outline" size="icon" onClick={toggle} aria-label={dark ? 'Show light theme' : 'Show dark theme'} title={dark ? 'Show light theme' : 'Show dark theme'}>
    {dark ? <Sun/> : <Moon/>}
  </Button>;
}
