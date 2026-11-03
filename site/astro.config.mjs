import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"

export default defineConfig({
  site: "https://jpowersdev.github.io",
  base: "/effect-documents",
  integrations: [
    starlight({
      title: "effect-documents",
      description: "Versioned Markdown documents with attributed history, anchored review and live editing, for Effect.",
      logo: { src: "./src/assets/logo.svg" },
      favicon: "/favicon.svg",
      // What a link to the site shows when it's shared
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://jpowersdev.github.io/effect-documents/social-preview.png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1280" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "640" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "effect-documents: versioned Markdown documents for Effect" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://jpowersdev.github.io/effect-documents/social-preview.png" } }
      ],
      customCss: ["./src/styles/custom.css"],
      // Code fits the content column from 1440px up; narrower screens wrap it
      expressiveCode: { defaultProps: { wrap: true } },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/jpowersdev/effect-documents" }],
      editLink: { baseUrl: "https://github.com/jpowersdev/effect-documents/edit/main/site/" },
      sidebar: [
        { label: "Getting started", slug: "getting-started" },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "API reference", items: [{ autogenerate: { directory: "api" } }] }
      ]
    })
  ]
})
