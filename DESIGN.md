---
name: "officetable"
colors:
  background: "--background"
  surface: "--card-bg"
  text: "--foreground"
  primary: "--primary"
---

# Design System: officetable

## Visual Theme & Atmosphere

- [observed] Existing first-party theme, shared component, and page sources define the current visual baseline.
- [inferred confidence=medium] Preserve the observed token vocabulary, density, and component conventions when adding new surfaces.

## Color Palette & Roles

- [observed] `--background: #ffffff`
- [observed] `--primary: #2563eb`
- [observed] `--primary-hover: #1d4ed8`
- [observed] `--primary-light: #3b82f6`
- [observed] `--accent: #dc2626`
- [observed] `--accent-light: #ef4444`
- [observed] `--color-background: var(--background)`
- [observed] `--color-foreground: var(--foreground)`

## Typography Rules

- [observed] `Arial, Helvetica, sans-serif`
- [inferred confidence=medium] Reuse the existing font stack and derive hierarchy from shared components before introducing new sizes.

## Component Stylings

- [observed] `app/players/[id]/components/AchievementChecklist.tsx`
- [observed] `app/players/[id]/components/AchievementProgressRing.tsx`
- [observed] `app/players/[id]/components/CareerHighlights.tsx`
- [observed] `app/players/[id]/components/CategoryProgressBars.tsx`
- [observed] `app/players/[id]/components/EloChart.tsx`
- [observed] `app/players/[id]/components/GamblingSection.tsx`
- [observed] `app/players/[id]/components/GameSection.tsx`
- [observed] `app/players/[id]/components/GameTabBar.tsx`
- [inferred confidence=medium] Prefer existing primitives and variants over page-local replacements.

## Layout Principles

- [inferred confidence=low] No named spacing tokens were detected; confirm the base spacing rhythm.
- [observed] Representative page: `app/page.tsx`
- [observed] Representative page: `app/gambling/page.tsx`
- [observed] Representative page: `app/gambling/bank/page.tsx`
- [observed] Representative page: `app/gambling/challenges/[id]/page.tsx`
- [observed] Representative page: `app/gambling/matches/[id]/page.tsx`
- [observed] Representative page: `app/gambling/new/page.tsx`
- [inferred confidence=medium] Match the density and alignment rhythm of representative pages.

## Motion & Interaction

- [inferred confidence=low] No motion token was detected; keep transitions restrained until interaction evidence is available.
- [inferred confidence=medium] Preserve visible hover, focus, pressed, loading, and reduced-motion behavior from existing primitives.

## Accessibility

- [inferred confidence=medium] Preserve semantic controls, keyboard focus visibility, and non-color state cues present in existing primitives.
- [inferred confidence=low] Contrast, touch targets, text scaling, and reduced-motion behavior require runtime verification.

## Source Evidence & Confidence

- [observed] path: `app/LeaderboardClient.tsx`
  sha256: `4687bcc0ac2ff84049567eb5122ab8f65675ca9808ad762811024289b04ad210`
  confidence: high
- [observed] path: `app/globals.css`
  sha256: `518325ff84033247c654723e202a52643c2b3aa49d4c5510792840daac453250`
  confidence: high
- [observed] path: `app/layout.tsx`
  sha256: `f36f2fa5878a341c0065ab73c9c4ce9ba06443d6146cbde9e4c72072eeed3089`
  confidence: high
- [observed] path: `app/page.tsx`
  sha256: `1679c191f30d7ac369227719747d57d701b744b18aeec82554ffc71276ac060d`
  confidence: high
- [observed] path: `app/gambling/layout.tsx`
  sha256: `218df7c84b9a30296fb9ee1cfd4f9b7839a2fcac38234866cfcbfe5c65e384a5`
  confidence: high
- [observed] path: `app/gambling/page.tsx`
  sha256: `134e37a9754116f4ba317071d0b5984842a0ddb4517f481e272a37856ae54381`
  confidence: high
- [observed] path: `app/gambling/bank/page.tsx`
  sha256: `e11ef76c1ca84a0b98033bb9d3d068129e046c97981e2197bf545aa6ebdbe0f7`
  confidence: high
- [observed] path: `app/gambling/challenges/[id]/page.tsx`
  sha256: `ecddb14c646cb9afa88e3f124f7c2afe9b915e3bbcb8d11f3ce3e9acc73850d9`
  confidence: high
- [observed] path: `app/gambling/matches/[id]/page.tsx`
  sha256: `643de60de67b2f9dac302248bd1778d4b3afc338c5eedd54461445bef0e8c730`
  confidence: high
- [observed] path: `app/gambling/new/page.tsx`
  sha256: `c949a3c83969879b14d2f48b8d61dff0ec50bf513aa16f62b865d9fef92f57af`
  confidence: high
- [observed] path: `app/ladder-history/page.tsx`
  sha256: `17f56a82db3b874368082e16ff8a4920a51ba1dd254b3e1a5597e1b3e597bfdb`
  confidence: high
- [observed] path: `app/matches/page.tsx`
  sha256: `ab8ef22531c575edd9d5b431b10f848be2863eb0834e6a464a75535a86cafb93`
  confidence: high
- [observed] path: `app/matches/[id]/page.tsx`
  sha256: `53ff855d46c4d7112d8881ff5e80313eda9908041eaf28b700aa0e0f29b9f389`
  confidence: high
- [observed] path: `app/matches/live/page.tsx`
  sha256: `477e64fb22a5fa3d002c642f66a3ad182485f8f3e61eaf384257f30ea57e13c4`
  confidence: high
- [observed] path: `app/matches/new/page.tsx`
  sha256: `28aa0837b6e6c9fc206c83adb3c42d914cc9e2b594b55b59f116ff0211d44baf`
  confidence: high
- [observed] path: `app/players/page.tsx`
  sha256: `e67cc823e402173b47ea7674f46374f0d004525b403a48749c56afca44c93d8b`
  confidence: high
- [observed] path: `app/players/[id]/page.tsx`
  sha256: `b12600bc3fc7bfbaa078a11f153d289e35ed9978eb3418ccfcfc041d672faeeb`
  confidence: high
- [observed] path: `app/players/[id]/components/AchievementChecklist.tsx`
  sha256: `09159a767343dc20ed94534c7031d68d6a027e67a70660423ad47b4829a3277a`
  confidence: high
- [observed] path: `app/players/[id]/components/AchievementProgressRing.tsx`
  sha256: `6ec41dce9884a629b3d3ad54478ba3ff075481b6395fb740f170e4677ce7d8b7`
  confidence: high
- [observed] path: `app/players/[id]/components/CareerHighlights.tsx`
  sha256: `8c2bacbe0ad5309973c2c195ecf7f70057d246ff622f2b6f786d215f90727472`
  confidence: high
- [observed] path: `app/players/[id]/components/CategoryProgressBars.tsx`
  sha256: `77f86c50bdf00344a61445afaa282160c8502999ed495b601f8d91cbcb3a5ad9`
  confidence: high
- [observed] path: `app/players/[id]/components/EloChart.tsx`
  sha256: `2ec63e16cb2d29b2ea9a2ff691aec9ee0b0ad43c5eb64b79d480ffcdf81db74f`
  confidence: high
- [observed] path: `app/players/[id]/components/GamblingSection.tsx`
  sha256: `a382e4c67a8abaab1dcc28b6bb8783483ff7d089f3b810f90101488d839eed22`
  confidence: high
- [observed] path: `app/players/[id]/components/GameSection.tsx`
  sha256: `4febf955e0b32d63deb03b50c9dc6fbbd7576c8db9251946e450874917bc11f6`
  confidence: high
- [observed] path: `app/players/[id]/components/GameTabBar.tsx`
  sha256: `84480d6834889d751e2a13abaebdcf2dcfd90eca7632a720b1d0badb24bb8936`
  confidence: high
- [observed] path: `app/players/[id]/components/PlayerHeader.tsx`
  sha256: `da4fee5c4360f2086995f5857f721a88202889aa5a7bc398e242378b79e9700b`
  confidence: high
- [observed] path: `app/players/[id]/components/RecentMatches.tsx`
  sha256: `5f5356a36db2c1a6fe20dc29d30632fc52958eab21311efe57823c22671b7e40`
  confidence: high
- [observed] path: `app/players/[id]/components/RivalsSection.tsx`
  sha256: `2d8fa50ee3054432cc253223d2a1c87cd0b14fa85dbb75ddc20feeaf9338bba4`
  confidence: high
- [observed] path: `app/players/[id]/components/StreakBadge.tsx`
  sha256: `2d700d63ba49ace058eaaccb72aa5416d18c86d9c66edda82adcde69e67cb6d2`
  confidence: high
- [observed] path: `app/players/[id]/components/WinLossBar.tsx`
  sha256: `e6f7175feec04cb132eba585b0c89da4e73f02801164afa148949c88db877c58`
  confidence: high
- [observed] path: `app/settings/page.tsx`
  sha256: `15365692bfc9ab174550d7fc263684956dcfa54a870be16c61ebf4925803050b`
  confidence: high
- [observed] path: `components/GambleOddsBoard.tsx`
  sha256: `133b88debe1cb812ee853b549f058fb09e4ace0a0073233414722132883801bd`
  confidence: high

## Known Gaps & Exceptions

- [inferred confidence=medium] Semantic intent inferred from implementation must be reviewed before this draft becomes project authority.
- [observed] Shape token `--background: #ffffff`
- [observed] Shape token `--foreground: #171717`
- [observed] Shape token `--color-background: var(--background)`
- [observed] Shape token `--color-foreground: var(--foreground)`
- [observed] Shape token `--background: #0c111a`
- [observed] Shape token `--foreground: #e7ebf3`
