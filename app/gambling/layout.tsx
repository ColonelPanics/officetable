'use client';

import { ReactNode } from 'react';
import Link from 'next/link';
import { MeProvider } from '@/lib/contexts/MeContext';
import { MeSwitcher } from '@/components/MeSwitcher';

// Layout for the gambling section: identity provider + a slim header with
// the "viewing as" switcher and a back link.

export default function GamblingLayout({ children }: { children: ReactNode }) {
  return (
    <MeProvider>
      <div className="min-h-screen bg-background">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between mb-6">
            <div>
              <Link href="/" className="text-sm text-gray-500 hover:text-primary transition-colors">
                ← Leaderboard
              </Link>
              <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                🎲 Gambling
                <span className="text-xs font-normal text-gray-500">(office moose bucks — virtual money)</span>
              </h1>
            </div>
            <MeSwitcher />
          </div>
          {children}
        </div>
      </div>
    </MeProvider>
  );
}