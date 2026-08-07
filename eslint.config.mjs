import { FlatCompat } from "@eslint/eslintrc";
import nextPlugin from "@next/eslint-plugin-next";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const config = [
  { ignores: [".next/**", "generated/**", "node_modules/**", "next-env.d.ts", "postcss.config.mjs"] },
  {
    files: ["eslint.config.mjs"],
    plugins: {
      "@next/next": nextPlugin,
    },
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
