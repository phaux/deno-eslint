# Deno-ESLint

Run ESLint on your Deno projects.

This is a reimplementation of Deno's TypeScript fork (which is implemented
partially in Rust) in just JavaScript so it can be used in your
TypeScript-ESLint config.

## Usage

First, create your `eslint.config.js`:

```js
import eslintJs from "npm:@eslint/js";
import tsEslint from "npm:typescript-eslint";
import { createDenoProgram } from "https://deno.land/x/deslint/index.js";

export default tsEslint.config(
  eslintJs.configs.recommended,
  ...tsEslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        programs: [await createDenoProgram()],
      },
    },
  },
);
```

Then run `eslint` like you would normally, but using `deno` instead of `node`:

```sh
deno run --allow-env --allow-net --allow-read --allow-write=.eslintcache --allow-sys=cpus npm:eslint .
```
