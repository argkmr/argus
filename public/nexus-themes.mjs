// Nexus-only colour choices. Hand-tuned surfaces, not a hue rotation of one skin.
// This catalog has no DOM, persistence, network or repository-theme side effects.
export const DEFAULT_NEXUS_THEME = "midnight";

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

// Keep the chosen hue intact; only lift/lower a secondary tone when its contrast
// needs it. Approved canvas, panel, raised-surface and accent colours are explicit.
function readableColour(hex, backgrounds, minimum, light) {
  const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16));
  for (let step = 0; step <= 255; step++) {
    const colour = `#${channels.map(value => Math.round(value + ((light ? 0 : 255) - value) * step / 255).toString(16).padStart(2, "0")).join("")}`;
    if (backgrounds.every(background => contrast(colour, background) >= minimum)) return colour;
  }
  throw new Error("Nexus palette could not satisfy its contrast contract");
}

function palette({ bg, surface, raised, selected, line, text, muted, accent, control }, light) {
  const backgrounds = [bg, surface, raised, selected];
  const readable = (colour, minimum = 4.5) => readableColour(colour, backgrounds, minimum, light);
  const colour = readable(accent);
  return Object.freeze({
    bg, surface, "surface-2": raised, "surface-3": selected,
    line, "line-soft": line,
    shadow: light ? "#12203312" : "#00000030",
    text: readable(text), muted: readable(muted), "muted-2": readable(muted),
    accent: colour,
    "accent-ink": contrast("#ffffff", colour) >= 4.5 ? "#ffffff" : "#111820",
    blue: colour,
    "control-line": readable(control, 3),
  });
}

// IDs remain stable for existing preferences. Each direction has a distinct,
// named dark and light palette: six choices per appearance, twelve in total.
const definitions = [
  {
    id: "midnight", names: { dark: "Midnight Slate", light: "Porcelain" },
    descriptions: { dark: "Inky slate with a restrained periwinkle accent", light: "Clean porcelain, soft grey panels and precise indigo details" },
    dark: { bg: "#11151e", surface: "#1a202d", raised: "#242d3e", selected: "#303c54", line: "#38465e", text: "#eef2fc", muted: "#b4bfd6", accent: "#a9b9fa", control: "#7687a7" },
    light: { bg: "#f8f9fb", surface: "#eff2f6", raised: "#ffffff", selected: "#e4ebfc", line: "#d4dbe4", text: "#263346", muted: "#5b687b", accent: "#3f5bb5", control: "#7a879a" },
  },
  {
    id: "ocean", names: { dark: "Deep Ocean", light: "Coastal Mist" },
    descriptions: { dark: "Deep blue water, quiet navy panels and a clear cyan accent", light: "Pale coastal blue with crisp teal details" },
    dark: { bg: "#091724", surface: "#102433", raised: "#162e42", selected: "#193b4e", line: "#2a455a", text: "#e6f1f8", muted: "#adc3d4", accent: "#61d4f3", control: "#6c8fa8" },
    light: { bg: "#f3f9fb", surface: "#eaf3f6", raised: "#fcfeff", selected: "#dcecf2", line: "#ccdee5", text: "#243b49", muted: "#526d7b", accent: "#09657e", control: "#718e9b" },
  },
  {
    id: "forest", names: { dark: "Forest Ink", light: "Botanical Paper" },
    descriptions: { dark: "Woodland ink, layered evergreen surfaces and a soft mint accent", light: "Airy botanical paper with calm green highlights" },
    dark: { bg: "#111a17", surface: "#172520", raised: "#21352c", selected: "#2d4b3b", line: "#364e42", text: "#eff7f2", muted: "#b1c8bb", accent: "#91d5b0", control: "#789b87" },
    light: { bg: "#f5f9f3", surface: "#edf3e9", raised: "#fefffc", selected: "#e0eddb", line: "#cddcc6", text: "#293f2e", muted: "#5c6e5c", accent: "#376745", control: "#7d9179" },
  },
  {
    id: "graphite", names: { dark: "Graphite", light: "Silver Cloud" },
    descriptions: { dark: "Neutral charcoal, soft silver type and a cool blue accent", light: "Neutral cloud-grey surfaces with understated slate-blue details" },
    dark: { bg: "#141619", surface: "#1b1e23", raised: "#23272e", selected: "#29364f", line: "#343b46", text: "#eef1f5", muted: "#a9b2bf", accent: "#9fb8ff", control: "#7c879a" },
    light: { bg: "#f7f8fa", surface: "#eef0f3", raised: "#ffffff", selected: "#e3e8ee", line: "#d3d9e1", text: "#2d3542", muted: "#606b7c", accent: "#4c6184", control: "#838e9e" },
  },
  {
    id: "violet", names: { dark: "Velvet Dusk", light: "Lavender Mist" },
    descriptions: { dark: "Muted aubergine with soft lilac highlights", light: "Barely-lavender paper with deep violet accents" },
    dark: { bg: "#18141e", surface: "#211c2c", raised: "#2d263b", selected: "#3a304e", line: "#4b3c60", text: "#f3edf9", muted: "#c5b8d6", accent: "#c7a8ed", control: "#9380ad" },
    light: { bg: "#faf7fc", surface: "#f0eaf5", raised: "#fffefe", selected: "#e9e0f2", line: "#dcd0e6", text: "#3c304b", muted: "#71627e", accent: "#765397", control: "#97859f" },
  },
  {
    id: "ember", names: { dark: "Ember Glow", light: "Warm Linen" },
    descriptions: { dark: "Warm espresso surfaces and a restrained apricot glow", light: "Natural linen, warm paper and a soft terracotta accent" },
    dark: { bg: "#1b1613", surface: "#251e19", raised: "#31271f", selected: "#473429", line: "#554235", text: "#f8efe7", muted: "#cebbaa", accent: "#edb38a", control: "#a08673" },
    light: { bg: "#fbf8f2", surface: "#f3ede2", raised: "#fffefa", selected: "#ece2d2", line: "#dfd2bf", text: "#473829", muted: "#766553", accent: "#995235", control: "#9e8870" },
  },
];

export const NEXUS_THEMES = Object.freeze(definitions.map(({ id, names, descriptions, dark, light }) => Object.freeze({
  id, label: names.dark, description: descriptions.dark,
  names: Object.freeze(names), descriptions: Object.freeze(descriptions),
  dark: palette(dark, false), light: palette(light, true),
})));

// Old saved directions migrate to the nearest curated palette without a reset or
// a backend migration. Accept readable slugs too; persistence uses stable IDs.
const aliases = Object.freeze({
  teal: "forest", rose: "violet", indigo: "midnight", sand: "ember",
  "midnight-slate": "midnight", porcelain: "midnight", "deep-ocean": "ocean", "coastal-mist": "ocean",
  "forest-ink": "forest", "botanical-paper": "forest", "silver-cloud": "graphite",
  "velvet-dusk": "violet", "lavender-mist": "violet", "ember-glow": "ember", "warm-linen": "ember",
});

export function normalizeNexusTheme(value) {
  const input = typeof value === "string" ? value.trim().toLowerCase() : "";
  const id = Object.hasOwn(aliases, input) ? aliases[input] : input;
  return NEXUS_THEMES.some(theme => theme.id === id) ? id : DEFAULT_NEXUS_THEME;
}

export function nexusThemeChoices(mode = "dark") {
  const appearance = mode === "light" ? "light" : "dark";
  return NEXUS_THEMES.map(theme => Object.freeze({
    id: theme.id, label: theme.names[appearance], description: theme.descriptions[appearance], palette: theme[appearance],
  }));
}

export function nexusThemeVariables(value, mode = "dark") {
  const theme = NEXUS_THEMES.find(theme => theme.id === normalizeNexusTheme(value));
  return Object.fromEntries(Object.entries(theme[mode === "light" ? "light" : "dark"])
    .map(([key, colour]) => [`--nexus-${key}`, colour]));
}
