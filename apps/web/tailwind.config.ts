import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Neutral surface tokens; aligned with the rest of the Vibe family.
        surface: {
          DEFAULT: 'rgb(252 252 251)',
          subtle: 'rgb(245 245 244)',
          muted: 'rgb(231 229 228)',
        },
        ink: {
          DEFAULT: 'rgb(28 25 23)',
          muted: 'rgb(87 83 78)',
          subtle: 'rgb(120 113 108)',
        },
        accent: {
          DEFAULT: 'rgb(13 148 136)',
          fg: 'rgb(255 255 255)',
        },
        danger: {
          DEFAULT: 'rgb(220 38 38)',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Inter',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;
