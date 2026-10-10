# Modern Navidrome & Subsonic Client (WIP)

A modern, high-performance, and custom music player client built with React Native and Expo for self-hosted Navidrome and Subsonic music servers.

This project is a heavily modernized fork of [Substreamer](https://github.com/ghenry22/substreamer) by Gaven Henry, licensed under GPL-3.0, re-architected to deliver a bespoke, Spotify-like user experience.

---

## Key Features

- **Spotify-Style Visual Hierarchy & Search**:
  - **Top Hit (Risultato Migliore)** card highlighting exact artist matches (with prominent avatar and badge) or the top song result with instant playback.
  - **Compact & Dense Song Rows**: Minimalist 48x48 album artwork rows without bloated meta-boxes, maintaining seamless integration with swipe gestures (swipe right to queue, swipe left for favorites/playlists).
  - **Horizontal Carousels**: Dedicated horizontal carousels for Artists (circular 90x90 avatars) and Albums (90x90 square covers with 1-line truncation).
  - **Expanded Queue Radio ("Riproduci simili")**: Instant "Play-First, Fetch-Later" smart queue generation with transparent offline fallback to cached local songs when the server is unreachable.
  - **Clean Header Navigation**: Prominent search bar exclusively on the Search tab, keeping Home, Library, and Favorites headers clean and uncluttered.

- **Audio Engine & Queue Management**:
  - Native queue audio engine (`react-native-queue-player`, Nitro modules).
  - Real-time partitioned queue view (current track, user-queued items, context queue).
  - Background playback resilience with lock screen and notification controls.

- **Local Storage & Offline-First**:
  - High-performance local SQLite storage powered by `@op-engineering/op-sqlite` and Drizzle ORM.
  - Fast offline music caching and metadata indexing.
  - Instant offline filtering and instant download status badges.

- **Bespoke UI & Fluid Animations**:
  - OLED-friendly dark mode design system (`#000000` / `#121212`).
  - Dynamic palette extraction from artwork using native image color analyzers.
  - 60 FPS transitions and micro-interactions powered by `react-native-reanimated`.

---

## Tech Stack

- **Framework**: React Native 0.76+, Expo SDK 57 (Expo Router)
- **Language**: TypeScript
- **State Management**: Zustand
- **Database**: `@op-engineering/op-sqlite` + Drizzle ORM
- **Animations & Gestures**: `react-native-reanimated`, `react-native-gesture-handler`
- **Audio Engine**: `react-native-queue-player`
- **Internationalization**: `i18next` (multi-language support including Italian, English, and more)

---

## Getting Started

### Prerequisites

- Node.js 18+
- JDK 17 (`JAVA_HOME`)
- Android SDK (`ANDROID_HOME`)

### Installation

```bash
# Clone the repository
git clone https://github.com/monti8403/ReSubstreamer.git
cd ReSubstreamer

# Install dependencies
npm install
```

### Running Tests

```bash
npm test
```

### Building for Android

```bash
# Debug build
npx expo run:android

# Release APK (via Gradle)
cd android
./gradlew assembleRelease
```

---

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**. See the `LICENSE` file for details.
