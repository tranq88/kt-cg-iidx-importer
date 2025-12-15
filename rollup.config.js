import terser from "@rollup/plugin-terser";

export default {
  input: "kt-cg-iidx-importer.user.js",
  output: {
    file: "kt-cg-iidx-importer.min.js",
    format: "iife",
  },
  plugins: [terser()],
};
