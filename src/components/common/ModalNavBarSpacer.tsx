import React from 'react';
import { View, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../contexts/ThemeContext';

/**
 * Dải đệm vùng thanh điều hướng hệ thống (Android 3-button / gesture bar, iOS home indicator).
 * Trên Android (app.json userInterfaceStyle: "dark"), các nút điều hướng có màu trắng,
 * nên ở Theme Sáng cần đặt nền tối (colors.barBg) cho đúng vùng insets.bottom
 * để nút điều hướng luôn hiển thị rõ ràng, không bị trùng màu trắng với nền modal.
 */
export function ModalNavBarSpacer({ backgroundColor }: { backgroundColor?: string } = {}) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const height = Platform.OS === 'android' ? Math.max(insets.bottom, 44) : insets.bottom;
  if (height <= 0) return null;

  const bg =
    backgroundColor ??
    (Platform.OS === 'android'
      ? isDark
        ? colors.surface
        : colors.barBg
      : colors.surface);

  return <View style={{ height, width: '100%', backgroundColor: bg }} />;
}
