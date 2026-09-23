# Architettura e Core

Lo stack si basa su React Native, Expo v57 e TypeScript.

**Audio Engine:** Moduli nativi (`react-native-queue-player`, Nitro Modules) gestiti tramite bridge. La UI visiva deve interagire esclusivamente tramite i controller esistenti.

**Database:** `@op-engineering/op-sqlite` locale gestito tramite Drizzle ORM.

**Stile e Animazioni:** Uso rigoroso di `StyleSheet` per componenti custom. Animazioni fluide gestite interamente con `react-native-reanimated`.
