// components/Logo.tsx
import React from 'react';
import { Image, ImageResizeMode, ImageStyle, StyleProp } from 'react-native';

type LogoVariant = 'wide';

interface LogoProps {
  variant?: LogoVariant;
  width?: number;
  height?: number;
  resizeMode?: ImageResizeMode;
  style?: StyleProp<ImageStyle>;
}

const logoSources = {
  wide: require('../assets/logo-new.png')
};

export default function Logo({
  variant = 'wide',
  width,
  height,
  resizeMode = 'contain',
  style,
}: LogoProps) {
  const source = logoSources[variant];

  const defaultSizes: Record<LogoVariant, { width: number; height: number }> = {
    wide: { width: 220, height: 140 }
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
