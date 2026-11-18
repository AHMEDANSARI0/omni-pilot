import type { Config } from 'tailwindcss';

/**
 * Tailwind reads the design tokens defined in `ui/tokens.css`. Colours are never
 * hard-coded in components - they resolve through these variables.
 */
const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './ui/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--canvas))',
        canvas: 'hsl(var(--canvas))',
        foreground: 'hsl(var(--foreground))',
        ink: {
          DEFAULT: 'hsl(var(--ink))',
          foreground: 'hsl(var(--ink-foreground))',
          soft: 'hsl(var(--ink-soft))',
        },
        glass: 'hsl(var(--glass) / var(--glass-alpha))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          soft: 'hsl(var(--primary-soft))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          strong: 'hsl(var(--accent-strong))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        warm: { DEFAULT: 'hsl(var(--warm))', strong: 'hsl(var(--warm-strong))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        sidebar: 'hsl(var(--sidebar))',
        success: {
          DEFAULT: 'hsl(var(--accent-strong))',
          soft: 'hsl(var(--primary-soft))',
          foreground: 'hsl(var(--accent-strong))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warm-strong))',
          soft: 'hsl(var(--warm))',
          foreground: 'hsl(24 70% 30%)',
        },
        danger: {
          DEFAULT: 'hsl(var(--destructive))',
          soft: 'hsl(var(--destructive) / 0.12)',
          foreground: 'hsl(6 70% 36%)',
        },
        info: {
          DEFAULT: 'hsl(208 70% 46%)',
          soft: 'hsl(206 80% 95%)',
          foreground: 'hsl(208 70% 30%)',
        },
      },
      borderRadius: {
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.25rem',
        '3xl': '1.5rem',
        panel: '1.75rem',
        field: '0.875rem',
      },
      boxShadow: {
        card: '0 1px 1px rgba(23,32,45,0.03), 0 12px 32px -14px rgba(23,32,45,0.22), 0 2px 6px -3px rgba(23,32,45,0.08)',
        glass:
          '0 1px 1px rgba(23,32,45,0.03), 0 12px 32px -14px rgba(23,32,45,0.22), 0 2px 6px -3px rgba(23,32,45,0.08)',
        pop: '0 24px 60px -28px rgba(23,32,45,0.35), 0 4px 12px -6px rgba(23,32,45,0.12)',
        pill: '0 10px 24px -12px rgba(23,32,45,0.55)',
        sidebar: 'none',
      },
      backdropBlur: { glass: '18px' },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { transform: 'translateY(12px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fade-in 140ms ease-out',
        'slide-up': 'slide-up 180ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
