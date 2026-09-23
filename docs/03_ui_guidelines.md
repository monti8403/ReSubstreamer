# Linee Guida UI/UX

- **Design Bespoke:** Nessun framework UI standard. Design bespoke dark-mode first (Sfondo OLED `#000000` o `#121212`).
- **Colori Dinamici:** Colori estratti dinamicamente dalle copertine tramite librerie native (`expo-image-colors`).
- **Player Fullscreen:** Player a tutto schermo richiamabile tramite BottomSheet fluido customizzato (usando `react-native-gesture-handler` e `react-native-reanimated`).
- **Touch Target:** Target touch minimi di 48x48dp. Nessuna eccezione.
