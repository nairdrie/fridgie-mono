import { ink } from '@/utils/styles';
import React from 'react';
import { Image, ImageStyle, StyleProp, View, ViewStyle } from 'react-native';

/** Approved vector master, exported at 512px for sharp native rendering. */
export function BrandMark({ size = 28, color = ink, style }: {
  size?: number;
  color?: string;
  style?: StyleProp<ImageStyle>;
}) {
  return <Image
    source={require('../../assets/brand/mark.png')}
    style={[{ width: size, height: size, tintColor: color }, style]}
    resizeMode="contain"
    fadeDuration={0}
    accessible={false}
    importantForAccessibility="no"
  />;
}

/** Outlined lettering keeps the approved wordmark identical on every platform. */
export function BrandLogotype({ height = 30, color = ink, accessible = true }: {
  height?: number;
  color?: string;
  accessible?: boolean;
}) {
  return <Image
    source={require('../../assets/brand/wordmark.png')}
    style={{ width: height * 3.2, height, tintColor: color }}
    resizeMode="contain"
    fadeDuration={0}
    accessible={accessible}
    accessibilityRole="image"
    accessibilityLabel="Fridgie"
    importantForAccessibility={accessible ? 'yes' : 'no'}
  />;
}

export function BrandWordmark({ height = 25, compact = false, color = ink, style }: {
  height?: number;
  compact?: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const letteringHeight = height * 0.82;
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: height * 0.24, flexShrink: 0, height }, style]} accessible accessibilityRole="image" accessibilityLabel="Fridgie">
    <BrandMark size={height} color={color} />
    {!compact && <BrandLogotype height={letteringHeight} color={color} accessible={false} />}
  </View>;
}
