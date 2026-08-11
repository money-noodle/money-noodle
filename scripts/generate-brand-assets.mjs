import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const source = 'money_noodle_logo_large.png';
await mkdir('public/brand', { recursive: true });

// Use one universal lockup: MONEY/tagline in Ramen Gold and NOODLE/rules in brand green.
const original = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const universalPixels = Buffer.from(original.data);
for (let y = 650; y < original.info.height; y += 1) {
  for (let x = 0; x < original.info.width; x += 1) {
    const offset = (y * original.info.width + x) * 4;
    const r = universalPixels[offset], g = universalPixels[offset + 1], b = universalPixels[offset + 2], alpha = universalPixels[offset + 3];
    if (alpha <= 0) continue;
    const navyInk = r < 75 && g < 95 && b < 125 && b > g * 1.08 && b > r * 1.25;
    const greenInk = g > 60 && g > r * 1.2 && g > b * 1.15;
    const target = navyInk ? [227, 176, 75] : greenInk ? [53, 169, 75] : null;
    if (target) {
      universalPixels[offset] = target[0]; universalPixels[offset + 1] = target[1]; universalPixels[offset + 2] = target[2];
    }
  }
}
const universalSource = await sharp(universalPixels, { raw: original.info }).png().toBuffer();
const lockup = () => sharp(universalSource).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 2 })
  .resize({ width: 1200, withoutEnlargement: true });
await lockup().png({ compressionLevel: 9, palette: true, quality: 100 }).toFile('public/brand/money-noodle-logo.png');
await lockup().webp({ quality: 92, alphaQuality: 100 }).toFile('public/brand/money-noodle-logo.webp');
const socialLogo = await lockup().resize({ width: 900, height: 560, fit: 'inside' }).toBuffer();
await sharp({ create: { width: 1200, height: 630, channels: 4, background: '#080b0c' } })
  .composite([{ input: socialLogo, gravity: 'centre' }])
  .png({ compressionLevel: 9 }).toFile('public/brand/money-noodle-social.png');

// Standalone mark: isolate the upper emblem, retain its glow, and center it on transparent squares.
// Materialize the crop before trim: libvips may otherwise move trim ahead of extract.
const markCrop = await sharp(source).extract({ left: 430, top: 45, width: 680, height: 620 }).toBuffer();
const markTrimmed = await sharp(markCrop)
  .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 2 }).toBuffer();
const square = async (size, background = { r: 0, g: 0, b: 0, alpha: 0 }) => {
  const emblem = await sharp(markTrimmed)
    .resize({ width: Math.round(size * 0.88), height: Math.round(size * 0.88), fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: emblem, gravity: 'centre' }]);
};

for (const size of [512, 192, 64, 32, 16]) {
  await (await square(size)).png({ compressionLevel: 9 }).toFile(`public/brand/money-noodle-icon-${size}.png`);
}
await (await square(512)).png({ compressionLevel: 9 }).toFile('app/icon.png');
await (await square(180, '#08100c')).png({ compressionLevel: 9 }).toFile('app/apple-icon.png');
