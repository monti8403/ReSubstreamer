import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useTranslation } from 'react-i18next';
import type { ThemeColors } from '../../constants/theme';

export interface QueueSectionHeaderProps {
  title: string;
  count?: number;
  onClear?: () => void;
  colors: Pick<ThemeColors, 'textPrimary' | 'textSecondary' | 'primary' | 'border'>;
}

export const QueueSectionHeader = memo(function QueueSectionHeader({
  title,
  count,
  onClear,
  colors,
}: QueueSectionHeaderProps) {
  const { t } = useTranslation();

  return (
    <View style={styles.container}>
      <View style={styles.leftRow}>
        <Text style={[styles.title, { color: colors.textSecondary }]}>
          {title.toUpperCase()}
        </Text>
        {count != null && count > 0 && (
          <View style={[styles.badge, { backgroundColor: colors.border }]}>
            <Text style={[styles.badgeText, { color: colors.textSecondary }]}>
              {count}
            </Text>
          </View>
        )}
      </View>
      {onClear && (
        <Pressable
          onPress={onClear}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('clearUserQueue')}
          style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}
        >
          <Ionicons name="trash-outline" size={14} color={colors.primary} style={styles.clearIcon} />
          <Text style={[styles.clearButtonText, { color: colors.primary }]}>
            {t('clearUserQueue')}
          </Text>
        </Pressable>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 8,
  },
  leftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  clearButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 6,
  },
  clearIcon: {
    marginRight: 2,
  },
  clearButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
});
