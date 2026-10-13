"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useTheme } from "@/lib/contexts/ThemeContext";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { setPlayerAvatarUrl, removePlayerAvatar } from "@/lib/avatarClient";
import { useSeasonalEffects } from "@/lib/hooks/useSeasonalEffects";

interface Game {
  id: number;
  name: string;
  score_type: 'best_of' | 'first_to';
  score_value: number;
  image_url?: string | null;
}

const COLOR_PRESETS = [
  { name: 'Ocean Blue', primary: '#2563eb', accent: '#dc2626', emoji: '🌊' },
  { name: 'Forest', primary: '#16a34a', accent: '#dc2626', emoji: '🌲' },
  { name: 'Royal Purple', primary: '#9333ea', accent: '#f97316', emoji: '👑' },
  { name: 'Sunset Orange', primary: '#ea580c', accent: '#0891b2', emoji: '🌅' },
  { name: 'Teal Wave', primary: '#0d9488', accent: '#f43f5e', emoji: '🏄' },
  { name: 'Cherry Red', primary: '#dc2626', accent: '#2563eb', emoji: '🍒' },
];

export default function SettingsPage() {
  const { settings: themeSettings, updateSettings: updateTheme, isLoading: themeLoading } = useTheme();
  const { enabled: seasonalEnabled, setEnabled: setSeasonalEnabled } = useSeasonalEffects();
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [editedUrls, setEditedUrls] = useState<Record<number, string>>({});
  const [inactiveThreshold, setInactiveThreshold] = useState('60');
  const [savingThreshold, setSavingThreshold] = useState(false);

  // Local form state for theme settings
  const [companyName, setCompanyName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [primaryColor, setPrimaryColor] = useState('');
  const [accentColor, setAccentColor] = useState('');
  const [savingTheme, setSavingTheme] = useState(false);

  // Player avatars
  interface Player {
    id: number;
    name: string;
    status: 'active' | 'retired';
    avatar_url?: string | null;
  }
  const [players, setPlayers] = useState<Player[]>([]);
  const [editedAvatarUrls, setEditedAvatarUrls] = useState<Record<number, string>>({});
  const [savingAvatar, setSavingAvatar] = useState<number | null>(null);

  // Sync local form state with theme context
  useEffect(() => {
    if (!themeLoading) {
      setCompanyName(themeSettings.company_name || '');
      setLogoUrl(themeSettings.logo_url || '');
      setPrimaryColor(themeSettings.primary_color || '#2563eb');
      setAccentColor(themeSettings.accent_color || '#dc2626');
    }
  }, [themeSettings, themeLoading]);

  useEffect(() => {
    fetch("/api/games")
      .then((res) => res.json())
      .then((data: Game[]) => {
        setGames(data);
        const urls: Record<number, string> = {};
        data.forEach(g => {
          if (g.image_url) urls[g.id] = g.image_url;
        });
        setEditedUrls(urls);
        setLoading(false);
      });
  }, []);

  // Load inactive threshold from settings
  useEffect(() => {
    async function loadThreshold() {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const data = await res.json();
          if (data.inactive_threshold_days) {
            setInactiveThreshold(data.inactive_threshold_days);
          }
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    }
    loadThreshold();
  }, []);

  useEffect(() => {
    fetch("/api/players?status=all")
      .then((res) => res.json())
      .then((data: Player[]) => {
        setPlayers(data);
        const urls: Record<number, string> = {};
        data.forEach(p => {
          if (p.avatar_url) urls[p.id] = p.avatar_url;
        });
        setEditedAvatarUrls(urls);
      })
      .catch(() => setPlayers([]));
  }, []);

  async function savePlayerAvatar(playerId: number) {
    setSavingAvatar(playerId);
    try {
      const url = editedAvatarUrls[playerId]?.trim() || '';
      await setPlayerAvatarUrl(playerId, url);
      setPlayers(players.map(p =>
        p.id === playerId ? { ...p, avatar_url: url || null } : p
      ));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save avatar");
    } finally {
      setSavingAvatar(null);
    }
  }

  async function handleRemoveAvatar(playerId: number) {
    setSavingAvatar(playerId);
    try {
      await removePlayerAvatar(playerId);
      setEditedAvatarUrls({ ...editedAvatarUrls, [playerId]: '' });
      setPlayers(players.map(p =>
        p.id === playerId ? { ...p, avatar_url: null } : p
      ));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to remove avatar");
    } finally {
      setSavingAvatar(null);
    }
  }

  const formatGameName = (name: string) => {
    return name.charAt(0).toUpperCase() + name.slice(1).replace("-", " ");
  };

  async function saveImageUrl(gameId: number) {
    setSaving(gameId);
    try {
      const res = await fetch("/api/games", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: gameId,
          image_url: editedUrls[gameId] || null
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to save");
      }

      // Update local state
      setGames(games.map(g =>
        g.id === gameId ? { ...g, image_url: editedUrls[gameId] || null } : g
      ));
    } catch (err) {
      console.error(err);
      alert("Failed to save image URL");
    } finally {
      setSaving(null);
    }
  }

  async function saveInactiveThreshold() {
    setSavingThreshold(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { inactive_threshold_days: inactiveThreshold } })
      });
      if (!res.ok) {
        throw new Error('Failed to save');
      }
      alert('Inactivity threshold saved!');
    } catch (err) {
      console.error(err);
      alert('Failed to save inactivity threshold');
    } finally {
      setSavingThreshold(false);
    }
  }

  // Seasons management
  interface Season {
    id: number;
    name: string;
    start_date: string;
    end_date: string | null;
    is_current: boolean;
    is_queued?: boolean;
  }
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [queueStartDate, setQueueStartDate] = useState('');
  const [queueName, setQueueName] = useState('');
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);

  const loadSeasons = () =>
    fetch('/api/seasons')
      .then((res) => res.json())
      .then((data) => setSeasons(data.seasons || []));

  useEffect(() => {
    loadSeasons().catch((err) => console.error('Failed to load seasons:', err));
  }, []);

  const formatSeasonDate = (dateStr: string | null) => {
    if (!dateStr) return null;
    return new Date(`${dateStr.replace(' ', 'T')}Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  async function queueSeason() {
    if (!queueStartDate) {
      alert('Pick a start date for the new season');
      return;
    }
    setQueueBusy(true);
    setQueueMessage(null);
    try {
      const res = await fetch('/api/seasons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: queueName || undefined, start_date: queueStartDate })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to queue season');
      }
      setQueueMessage(`Queued ${data.season.name} (starts ${formatSeasonDate(data.season.start_date)}); the previous season now ends there.`);
      setQueueStartDate('');
      setQueueName('');
      await loadSeasons();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Failed to queue season');
    } finally {
      setQueueBusy(false);
    }
  }

  async function unqueueSeason(id: number) {
    if (!confirm('Remove this queued season? The previous season will stay open until you queue a new one.')) return;
    try {
      const res = await fetch('/api/seasons', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to remove season');
      }
      await loadSeasons();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Failed to remove season');
    }
  }

  async function handleThemeSave() {
    setSavingTheme(true);
    try {
      await updateTheme({
        company_name: companyName,
        logo_url: logoUrl,
        primary_color: primaryColor,
        accent_color: accentColor,
      });
      alert('Theme settings saved!');
    } catch (err) {
      console.error(err);
      alert('Failed to save theme settings');
    } finally {
      setSavingTheme(false);
    }
  }

  function applyPreset(preset: typeof COLOR_PRESETS[0]) {
    setPrimaryColor(preset.primary);
    setAccentColor(preset.accent);
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Settings</h1>
          <p className="text-gray-500 mt-1">Customize your Office Games experience</p>
        </div>
        <Link
          href="/"
          className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-medium hover:bg-gray-300 transition-colors"
        >
          ← Back
        </Link>
      </div>

      {/* Branding Section */}
      <div className="bg-card rounded-xl shadow-lg overflow-hidden mb-6">
        <div className="px-6 py-4 bg-gradient-to-r from-slate-800 to-slate-900">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="text-xl">✏️</span> Branding
          </h2>
          <p className="text-gray-400 text-sm mt-1">Customize the app name and logo</p>
        </div>
        <div className="p-6 space-y-6">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              App Name
            </label>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Office Games"
              className="w-full max-w-md px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-lg"
            />
            <p className="text-xs text-gray-500 mt-2">
              This name will appear in the navigation bar.
            </p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Logo URL
            </label>
            <div className="flex gap-4 items-start">
              <div className="flex-1 max-w-md">
                <input
                  type="url"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="https://example.com/logo.png"
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                />
              </div>
              <div className="w-16 h-16 bg-gray-100 rounded-xl flex items-center justify-center overflow-hidden">
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt="Logo preview"
                    className="w-12 h-12 object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <span className="text-2xl text-gray-400">🖼️</span>
                )}
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Enter a URL to your logo image (PNG, JPG, or SVG)
            </p>
          </div>
        </div>
      </div>

      {/* Colors Section */}
      <div className="bg-card rounded-xl shadow-lg overflow-hidden mb-6">
        <div className="px-6 py-4 bg-gradient-to-r from-purple-600 to-pink-600">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="text-xl">🎨</span> Colors
          </h2>
          <p className="text-white/85 text-sm mt-1">Choose your app's color scheme</p>
        </div>
        <div className="p-6 space-y-6">
          {/* Presets */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-3">
              Quick Presets
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
              {COLOR_PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => applyPreset(preset)}
                  className="group relative p-3 border-2 border-gray-200 rounded-xl hover:border-primary transition-all hover:shadow-md"
                >
                  <div className="text-2xl mb-2">{preset.emoji}</div>
                  <div className="text-sm font-medium text-gray-700">{preset.name}</div>
                  <div className="flex justify-center gap-1 mt-2">
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: preset.primary }}
                    />
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: preset.accent }}
                    />
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Custom Colors */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Primary Color
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="w-14 h-14 border-2 border-gray-200 rounded-xl cursor-pointer"
                />
                <div className="flex-1">
                  <input
                    type="text"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent font-mono"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-2">Used for buttons, links, and primary actions</p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Accent Color
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="w-14 h-14 border-2 border-gray-200 rounded-xl cursor-pointer"
                />
                <div className="flex-1">
                  <input
                    type="text"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent font-mono"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-2">Used for highlights and warnings</p>
            </div>
          </div>

          {/* Live Preview */}
          <div className="p-5 bg-gray-50 rounded-xl border border-gray-200">
            <label className="block text-sm font-semibold text-gray-500 mb-4 uppercase tracking-wide">
              Live Preview
            </label>
            <div className="bg-card rounded-xl shadow-lg p-4">
              <div className="flex items-center justify-between mb-4 pb-4 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
                    style={{ backgroundColor: primaryColor }}
                  >
                    {companyName?.charAt(0) || 'O'}
                  </div>
                  <span className="font-bold text-lg">{companyName || 'Office Games'}</span>
                </div>
                <span style={{ color: primaryColor }} className="font-medium">Link</span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  className="px-4 py-2 rounded-lg text-white font-medium shadow-sm"
                  style={{ backgroundColor: primaryColor }}
                >
                  Primary Button
                </button>
                <button
                  className="px-4 py-2 rounded-lg bg-gray-200 text-gray-800 font-medium"
                >
                  Secondary
                </button>
                <span style={{ color: accentColor }} className="font-medium">
                  Accent
                </span>
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <button
              onClick={handleThemeSave}
              disabled={savingTheme}
              className="px-6 py-3 bg-primary text-white rounded-xl font-semibold hover:bg-primary-hover transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingTheme ? "Saving..." : "💾 Save Theme"}
            </button>
          </div>
        </div>
      </div>

      {/* Seasonal Flair Section */}
      <div className="bg-card rounded-xl shadow-lg overflow-hidden mb-6">
        <div className="px-6 py-4 bg-gradient-to-r from-emerald-500 to-teal-500">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="text-xl">🎄</span> Seasonal Flair
          </h2>
          <p className="text-white/85 text-sm mt-1">Festive decorations on the leaderboard</p>
        </div>
        <div className="p-6">
          <div className="flex items-start justify-between gap-4 max-w-2xl">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Show seasonal effects
              </label>
              <p className="text-xs text-gray-500">
                Drifting decorations (snow, pumpkins, fireworks...) and seasonal colors on the leaderboard, appearing around Halloween, Valentine's Day and the winter holidays.
              </p>
              <p className="text-xs text-gray-400 mt-2">
                This is a per-browser preference — each browser/device toggles independently.
              </p>
            </div>
            {/* Toggle switch */}
            <button
              role="switch"
              aria-checked={seasonalEnabled !== false}
              onClick={() => setSeasonalEnabled(seasonalEnabled === false)}
              disabled={seasonalEnabled === null}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors ${
                seasonalEnabled === false ? 'bg-gray-300' : 'bg-primary'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-card rounded-full shadow transition-transform ${
                  seasonalEnabled === false ? 'translate-x-0' : 'translate-x-6'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Game Images Section */}
      <div className="bg-card rounded-xl shadow-lg overflow-hidden mb-6">
        <div className="px-6 py-4 bg-gradient-to-r from-blue-500 to-cyan-500">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="text-xl">🎮</span> Game Images
          </h2>
          <p className="text-white/85 text-sm mt-1">Set images for each game (used in notifications)</p>
        </div>
        <div className="p-6">
          {loading ? (
            <div className="text-gray-500">Loading...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {games.map((game) => (
                <div key={game.id} className="bg-gray-50 rounded-xl p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-gray-200 rounded-lg flex items-center justify-center overflow-hidden">
                      {editedUrls[game.id] || game.image_url ? (
                        <img
                          src={editedUrls[game.id] || game.image_url || ''}
                          alt={game.name}
                          className="w-8 h-8 object-contain"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <span className="text-xl">🎯</span>
                      )}
                    </div>
                    <span className="font-semibold text-gray-900">{formatGameName(game.name)}</span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={editedUrls[game.id] || ""}
                      onChange={(e) => setEditedUrls({ ...editedUrls, [game.id]: e.target.value })}
                      placeholder="https://example.com/icon.png"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-sm"
                    />
                    <button
                      onClick={() => saveImageUrl(game.id)}
                      disabled={saving === game.id}
                      className="px-3 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
                    >
                      {saving === game.id ? "..." : "Save"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Player Avatars Section */}
      <div className="bg-card rounded-xl shadow-lg overflow-hidden mb-6">
        <div className="px-6 py-4 bg-gradient-to-r from-indigo-500 to-violet-500">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="text-xl">👤</span> Player Avatars
          </h2>
          <p className="text-white/85 text-sm mt-1">Set an image link for each player (shown on leaderboards, profiles &amp; chat notifications)</p>
        </div>
        <div className="p-6">
          {players.length === 0 ? (
            <div className="text-gray-500">No players yet.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {players.map((player) => (
                <div key={player.id} className="bg-gray-50 rounded-xl p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <PlayerAvatar
                      name={player.name}
                      avatarUrl={editedAvatarUrls[player.id] || player.avatar_url}
                      size={40}
                      className={player.status === 'retired' ? 'grayscale' : ''}
                    />
                    <span className={`font-semibold text-sm truncate ${player.status === 'retired' ? 'text-gray-500 line-through' : 'text-gray-900'}`}>
                      {player.name}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={editedAvatarUrls[player.id] || ""}
                      onChange={(e) => setEditedAvatarUrls({ ...editedAvatarUrls, [player.id]: e.target.value })}
                      placeholder="https://example.com/avatar.png"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-sm"
                    />
                    <button
                      onClick={() => savePlayerAvatar(player.id)}
                      disabled={savingAvatar === player.id}
                      className="px-3 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
                    >
                      {savingAvatar === player.id ? "..." : "Save"}
                    </button>
                    {player.avatar_url && (
                      <button
                        onClick={() => handleRemoveAvatar(player.id)}
                        disabled={savingAvatar === player.id}
                        className="px-2 py-2 text-gray-400 hover:text-red-500 transition-colors text-sm"
                        title="Remove avatar"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-500 mt-3">
            Use a publicly-reachable image link (like the game images above) so avatars can also be embedded in Google Chat notifications.
          </p>
        </div>
      </div>

      {/* Inactivity Threshold Section */}
      <div className="bg-card rounded-xl shadow-lg overflow-hidden mb-6">
        <div className="px-6 py-4 bg-gradient-to-r from-gray-600 to-gray-700 dark:from-[#3a4356] dark:to-[#2e3644]">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="text-xl">💤</span> Inactivity
          </h2>
          <p className="text-gray-300 text-sm mt-1">Hide players from leaderboards who haven&apos;t played recently</p>
        </div>
        <div className="p-6">
          <div className="max-w-md">
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Inactive threshold (days)
            </label>
            <p className="text-xs text-gray-500 mb-3">
              Players who haven&apos;t played a match in this game type for more than this many days will be hidden from the leaderboard by default.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min="1"
                value={inactiveThreshold}
                onChange={(e) => setInactiveThreshold(e.target.value)}
                className="w-24 px-3 py-2 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-center text-lg font-semibold"
              />
              <span className="text-sm text-gray-500">days</span>
              <button
                onClick={saveInactiveThreshold}
                disabled={savingThreshold}
                className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingThreshold ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Seasons Section */}
      <div className="bg-card rounded-xl shadow-lg overflow-hidden mb-6">
        <div className="px-6 py-4 bg-gradient-to-r from-indigo-500 to-violet-600">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="text-xl">🗓️</span> Seasons
          </h2>
          <p className="text-white/85 text-sm mt-1">Queue the next season&apos;s start — season skill resets to 0 when it begins</p>
        </div>
        <div className="p-6">
          <div className="mb-6 space-y-2">
            {seasons.map((season) => (
              <div key={season.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3">
                  <span className="font-medium text-gray-900">{season.name}</span>
                  <span className="text-sm text-gray-500">
                    {formatSeasonDate(season.start_date)} — {season.end_date ? formatSeasonDate(season.end_date) : 'ongoing'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {season.is_current && (
                    <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Current</span>
                  )}
                  {season.is_queued && (
                    <>
                      <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">Queued</span>
                      <button
                        onClick={() => unqueueSeason(season.id)}
                        className="text-xs text-red-500 hover:text-red-700 hover:underline"
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Queue next season</h3>
            <p className="text-xs text-gray-500 mb-3">
              Seasons never gap or overlap: the latest season is automatically closed exactly where the new one starts.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                placeholder="Name (optional, e.g. Season 2)"
                value={queueName}
                onChange={(e) => setQueueName(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              />
              <input
                type="datetime-local"
                value={queueStartDate}
                onChange={(e) => setQueueStartDate(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              />
              <button
                onClick={queueSeason}
                disabled={queueBusy}
                className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {queueBusy ? 'Queuing…' : 'Queue Season'}
              </button>
            </div>
            {queueMessage && <p className="text-sm text-green-600 mt-3">{queueMessage}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}