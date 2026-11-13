// Shiki themes for the docs' code blocks, in the colours of the landing page's
// "Configure it in code" walkthrough: cobalt keywords, amber strings, ink
// names. Shiki writes both as CSS variables (`defaultColor: false`), and
// docs.css picks one by the page's theme (the .dark class).

type Palette = {
  name: string;
  type: "light" | "dark";
  background: string;
  text: string;
  muted: string;
  keyword: string;
  string: string;
  constant: string;
};

function theme(palette: Palette) {
  return {
    name: palette.name,
    type: palette.type,
    colors: {
      "editor.background": palette.background,
      "editor.foreground": palette.text,
    },
    settings: [
      { settings: { foreground: palette.text } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: palette.muted },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "keyword.operator.new",
          "keyword.operator.expression",
          "variable.language",
        ],
        settings: { foreground: palette.keyword },
      },
      {
        scope: ["string", "string.quoted", "string.template", "markup.inline"],
        settings: { foreground: palette.string },
      },
      {
        scope: [
          "constant.numeric",
          "constant.language",
          "constant.other.option",
          "support.constant",
        ],
        settings: { foreground: palette.constant },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "entity.name.command",
          "entity.name.type",
          "entity.name.class",
        ],
        settings: { foreground: palette.text, fontStyle: "bold" },
      },
      {
        scope: ["punctuation", "meta.brace", "keyword.operator"],
        settings: { foreground: palette.muted },
      },
    ],
  };
}

export const codeThemes = {
  light: theme({
    name: "openworkspace-light",
    type: "light",
    background: "#ffffff",
    text: "#161a2b",
    muted: "#5d6478",
    keyword: "#2c4fbb",
    string: "#9a5a00",
    constant: "#1d7a4e",
  }),
  dark: theme({
    name: "openworkspace-dark",
    type: "dark",
    background: "#181b24",
    text: "#e8eaf2",
    muted: "#a4a9ba",
    keyword: "#a6b8f7",
    string: "#ffc97a",
    constant: "#6fd3a0",
  }),
};
