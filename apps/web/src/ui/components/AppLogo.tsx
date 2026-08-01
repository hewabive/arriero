type AppLogoProps = {
  size?: number;
};

export function AppLogo({ size = 26 }: AppLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Arriero"
      focusable="false"
    >
      <defs>
        <linearGradient id="app-logo-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4dabf7" />
          <stop offset="1" stopColor="#7048e8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#app-logo-gradient)" />
      <path
        fill="#fff"
        d="M16 58V41c0-8 3-13.5 9-16.5v-4L22 6l9.5 9h5L46 6l-3 14.5v4c6 3 10 7.5 10 13 0 4-2.5 6.5-7 6.5H34c-4 0-6 2.5-6 7v7z"
      />
      <circle cx="36" cy="27.5" r="2.7" fill="#3b2a7a" />
    </svg>
  );
}
