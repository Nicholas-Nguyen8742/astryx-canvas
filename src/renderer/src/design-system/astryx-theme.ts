/**
 * Astryx theming adapter (NFR-MAINT-06).
 *
 * Everything the app knows about how the design system is wired lives here, so no
 * other module reaches into the CLI-managed theme module directly.
 */
import { defaultThemeSlug, themes } from "../../../../astryx-themes";

type ThemeSlug = keyof typeof themes;

/**
 * `defaultThemeSlug` is emitted as a plain string, so indexing the themes record
 * with it needs a narrowing step. Failing loudly here is better than handing
 * `<Theme>` an undefined object and rendering an unstyled app.
 */
const slug = defaultThemeSlug as ThemeSlug;
const resolved = themes[slug];

if (!resolved) {
  throw new Error(
    `Astryx theme "${defaultThemeSlug}" is recorded as the default but was not generated. Re-run "astryx theme add ${defaultThemeSlug}".`,
  );
}

export const astryxTheme = resolved;
export const activeThemeSlug = slug;
