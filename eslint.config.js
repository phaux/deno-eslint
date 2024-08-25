// @ts-check
// import eslint from "npm:@eslint/js";
import tsEslint from "npm:typescript-eslint";
import { createDenoProgram } from "./createDenoProgram.ts";

export default tsEslint.config(
  // eslint.configs.recommended,
  ...tsEslint.configs.recommendedTypeChecked,
  // ...tsEslint.configs.strictTypeChecked,
  // ...tsEslint.configs.stylisticTypeChecked,
  {
    linterOptions: { reportUnusedDisableDirectives: true },
    languageOptions: {
      ecmaVersion: 2023,
      parserOptions: {
        project: true,
        programs: [await createDenoProgram()],
      },
    },
  },
);
