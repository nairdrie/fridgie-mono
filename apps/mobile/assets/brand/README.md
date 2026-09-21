# Fridgie identity

Approved leaf / negative-space **f**, from the external identity study.

- `mark.svg`: original editable contour; its open vein is a real cutout.
- `wordmark.svg`: approved rounded lettering converted to outlines, with no font dependency.
- `mark.png`: 512px transparent native export. `BrandMark` can tint it.
- `wordmark.png`: 768 × 240 transparent native export, used by `BrandWordmark`.
- `icon.svg` / `icon.png`: 1024px opaque evergreen field and ivory mark. Corners are left square for the OS mask.
- `adaptive-icon.svg` / `adaptive-icon.png`: transparent 1024px foreground with extra space for Android masks; background is configured in `app.json`.
- `splash.png`: transparent mark on the ivory launch screen.
- `favicon.png`: 64px favicon.

Palette: forest `#173F35`, evergreen `#23785E`, ivory `#F5F5EF`.

SVG masters are the source of truth. Raster exports were rendered directly from those vectors; the concept image is not used in the application. No new native library or bundled font is required.
