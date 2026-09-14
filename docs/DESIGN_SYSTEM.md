# R0 design system

The design foundation lives in `apps/web/app/globals.css` and reusable components under `apps/web/components`.

- Eight-step spacing scale, three surface levels, two line strengths, focused typography, compact monospaced metadata, and small/medium/large radii.
- Dark canvas with restrained cyan/violet ambient fields and a lime focus/action accent. The variables are ready to accept artwork-derived local colors without making contrast depend on them.
- Reusable page heading, status pill, empty state, button, shell, entity shell, tab, input, and loading patterns.
- Desktop rail at 1280–1536, compact rail at 768–1024, and a recomposed bottom-navigation layout below 768. A dedicated 390 px pass keeps controls usable and content ordered vertically.
- Hover/press/page/ambient motion is restrained and all animation collapses under `prefers-reduced-motion`.
- R0 uses neutral signal/orbit geometry, never fake artwork or a fake functional player/waveform.

