# Deno-ESLint

[![deno](https://doc.deno.land/badge.svg)](https://deno.land/x/deslint)

Run ESLint on your Deno projects.

This is a reimplementation of Deno's TypeScript fork (which is implemented
partially in Rust) in just JavaScript so it can be used in your
TypeScript-ESLint config.

It downloads all HTTP/npm/jsr dependencies to a virtual FS first and creates a
TS Program based on it.

## Usage

First, create your `eslint.config.js`:

```js
import eslintJs from "npm:@eslint/js";
import tsEslint from "npm:typescript-eslint";
import { createDenoProgram } from "https://deno.land/x/deslint/mod.ts";

export default tsEslint.config(
  eslintJs.configs.recommended,
  ...tsEslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        programs: [
          await createDenoProgram({
            entryGlob: "./main.ts", // set this or add `exports` to `deno.json`
          }),
        ],
      },
    },
  },
);
```

Then run `eslint` like you would normally, but using `deno` instead of `node`:

```sh
deno run --allow-env --allow-net --allow-read --allow-write=.eslintcache --allow-sys=cpus npm:eslint .
```

deno-eslint will load compiler options, entry file paths (exports), and import
map from `deno.json` if it exists. By default, every js/ts file in current
directory and subdirectories is added as an entry.

## Example

`main.ts`

```ts
import { copy } from "jsr:@std/fs";

copy("file.txt", "file2.txt");
```

Result:

```txt
/home/you/code/deno-eslint-test/main.ts
  3:1  error  Promises must be awaited, end with a call to .catch, 
              end with a call to .then with a rejection handler or 
              be explicitly marked as ignored with the `void` operator  
              @typescript-eslint/no-floating-promises

✖ 1 problem (1 error, 0 warnings)
```
