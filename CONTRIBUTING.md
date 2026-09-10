# Contributing to ReSubstreamer

Thank you for your interest in making **ReSubstreamer** better! We welcome bug fixes, performance improvements, documentation updates, and feature implementations from the community.

---

## Code of Conduct

Please be respectful, constructive, and polite in all interactions within issues, pull requests, and discussions.

---

## Development Workflow

### 1. Environment Setup
1. Ensure you have **Android Studio / Android SDK (Platform 35)** and **JDK 17** installed.
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/ReSubstreamer.git
   cd ReSubstreamer
   ```
3. Install project dependencies:
   ```bash
   npm install
   ```

### 2. Branching Strategy
- `master` / `main`: Contains stable, release-ready code. Do **not** submit PRs directly targeting unreleased features to `master`.
- Feature Branches: Create descriptive branches from `master`:
  ```bash
  git checkout -b feature/lockscreen-visualizer
  # or
  git checkout -b fix/queue-reorder-jump
  ```

### 3. Commit Message Guidelines
We follow standard [Conventional Commits](https://www.conventionalcommits.org/):
- `feat(player): add swipe-to-dismiss queue sheet gesture`
- `fix(audio): prevent audio focus drop during cellular network handover`
- `perf(cache): optimize thumbnail disk cache eviction policy`
- `docs: update server compatibility table in README`

---

## Submitting Pull Requests

1. **Keep it focused:** Each pull request should address a single bug fix or feature.
2. **Test on real hardware:** Always verify background playback, notification controls, and battery optimization on a physical device whenever possible.
3. **Fill out the template:** Complete the PR checklist provided by the GitHub template.
4. **CI/Build Verification:** Ensure local compilation succeeds without errors:
   ```bash
   cd android && ./gradlew app:assembleDebug
   ```

---

## Reporting Issues

- Before opening an issue, check existing [open and closed issues](https://github.com/monti8403/ReSubstreamer/issues) to avoid duplicates.
- Provide full details including server type, server version, device model, and exact steps to reproduce.
