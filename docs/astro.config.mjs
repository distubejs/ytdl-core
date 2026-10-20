import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

const base = "/ytdl-core";

export default defineConfig({
  site: "https://distubejs.github.io",
  base,
  integrations: [
    starlight({
      title: "ytdl-core",
      description: "YouTube video info and downloads for Node.js.",
      customCss: ["./src/styles/theme.css"],
      components: { Hero: "./src/components/Hero.astro" },
      head: [
        { tag: "link", attrs: { rel: "expect", href: "#_top", blocking: "render" } },
        ...["figtree-latin", "league-spartan-latin"].map((font) => ({
          tag: "link",
          attrs: {
            rel: "preload",
            href: `${base}/fonts/${font}.woff2`,
            as: "font",
            type: "font/woff2",
            crossorigin: true,
          },
        })),
      ],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/distubejs/ytdl-core" }],
      sidebar: [
        { label: "Start here", items: ["getting-started"] },
        {
          label: "Guides",
          items: [
            "guides/info",
            "guides/captions",
            "guides/search",
            "guides/download",
            "guides/formats",
            "guides/live",
            "guides/clients",
            "guides/cookies",
            "guides/po-tokens",
            "guides/proxies",
            "guides/errors",
          ],
        },
        typeDocSidebarGroup,
      ],
      plugins: [
        starlightTypeDoc({
          entryPoints: ["../src/index.ts"],
          tsconfig: "../tsconfig.build.json",
          output: "api",
          sidebar: { label: "API reference", collapsed: true },
          typeDoc: {
            readme: "./api-readme.md",
            skipErrorChecking: true,
            excludePrivate: true,
            interfacePropertiesFormat: "table",
            parametersFormat: "table",
            enumMembersFormat: "table",
            typeDeclarationFormat: "table",
            tableColumnSettings: { hideSources: true, hideModifiers: true },
            disableSources: true,
          },
        }),
      ],
    }),
  ],
  vite: { server: { fs: { allow: [".."] } } },
});
