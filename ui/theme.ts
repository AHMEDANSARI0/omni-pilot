/**
 * JS mirror of the CSS tokens, for the few places that cannot use classes
 * (SVG charts, gradients passed to components). Values here must stay in sync
 * with ui/tokens.css - that file is the source of truth for the palette.
 */
export const theme = {
  /** Semantic colours as CSS colour strings. */
  colors: {
    ink: 'hsl(220 22% 12%)',
    inkMuted: 'hsl(220 10% 42%)',
    mint: 'hsl(158 52% 62%)',
    mintSoft: 'hsl(155 52% 90%)',
    peach: 'hsl(20 92% 74%)',
    coral: 'hsl(8 84% 64%)',
    grid: 'hsl(220 16% 88% / 0.7)',
  },
  radius: { card: 24, panel: 28, field: 14 },
} as const;

/** Stroke colour for the activity chart, in the same order as its series. */
export const chartColors = [theme.colors.mint, theme.colors.peach, theme.colors.ink] as const;
