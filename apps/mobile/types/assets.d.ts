// Metro bundles static image assets to a module id (number). These
// declarations let TS accept `import X from './x.webp'` before Expo
// generates expo-env.d.ts on first `expo start`.
declare module '*.webp';
declare module '*.png';
declare module '*.jpg';
