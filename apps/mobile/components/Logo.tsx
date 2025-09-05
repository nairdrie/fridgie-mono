// components/Logo.tsx
import React from 'react';
import { Image, ImageResizeMode, ImageStyle, StyleProp } from 'react-native';

type LogoVariant = 'tall' | 'wide' | 'small' | 'new';

interface LogoProps {
  variant?: LogoVariant;
  width?: number;
  height?: number;
  resizeMode?: ImageResizeMode;
  style?: StyleProp<ImageStyle>;
}

const logoSources = {
  tall: require('../assets/logo_tall.png'),
  wide: require('../assets/logo_wide.png'),
  small: require('../assets/logo_small.png'),
  // new: require('../assets/logo-new.png')
  new: require('../assets/fridgieLogo.png')
};

export default function Logo({
  variant = 'tall',
  width,
  height,
  resizeMode = 'contain',
  style,
}: LogoProps) {
  const source = logoSources[variant];

  const defaultSizes: Record<LogoVariant, { width: number; height: number }> = {
    tall: { width: 240, height: 160 },
    wide: { width: 280, height: 140 },
    small: { width: 200, height: 200 },
    // new: { width: 220, height: 140 },
    new: { width: 300, height: 180 }
  };

  const dimensions = {
    width: width ?? defaultSizes[variant].width,
    height: height ?? defaultSizes[variant].height,
  };

  return (
    <Image
      source={source}
      resizeMode={resizeMode}
      style={[dimensions, style]}
    />
  );
}
