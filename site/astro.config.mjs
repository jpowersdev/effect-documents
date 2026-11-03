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
