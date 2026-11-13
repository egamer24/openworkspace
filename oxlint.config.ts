import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import playwright from "ultracite/oxlint/playwright";
import react from "ultracite/oxlint/react";

import { ignoredPaths } from "./tools/ignores.ts";

// Effect code: the Alchemy layer, and the dev stacks and test harnesses that
// compose it.
const effectFiles = [
  "packages/*/alchemy/**",
  "packages/core/dev/**",
  "packages/core/testing/**",
  "packages/core/test/examples/**",
  "apps/landing/alchemy.run.ts",
];

const testFiles = [
  "**/test/**",
  "**/*.test.{ts,tsx}",
  "**/*.spec.{ts,tsx}",
  "packages/core/testing/**",
];

export default defineConfig({
  env: core.env,
  extends: [core, react, playwright],
  ignorePatterns: [...core.ignorePatterns, ...ignoredPaths],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  rules: {
    // ── anti-slop ───────────────────────────────────────────────────────
    // Every rule, everywhere. Untrusted input is parsed with zod at its
    // boundary; the assertions that remain carry a `SAFETY:` comment.
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",

    // The React Compiler and Rules of React diagnostics (react/todo, refs,
    // set-state-in-effect, …) stay on from Ultracite's react preset: the app
    // is built with react({ compiler: true }), and code that breaks them is
    // left unoptimized.

    // ── Ultracite rules that don't fit this codebase ────────────────────
    // Key order is meaningful: JSON and API output, UI field order, and
    // drizzle column order. Sorting would change behaviour.
    "eslint/sort-keys": "off",
    // The code is written top-down with hoisted function declarations
    // (helpers and components below their callers). Converting them to
    // const arrow functions would make that order a TDZ error.
    "eslint/func-style": "off",
    "react/function-component-definition": "off",
    // References from inside functions that run later are fine; same-scope
    // use before definition (a real TDZ error) is still reported.
    "eslint/no-use-before-define": [
      "error",
      { functions: false, classes: false, variables: false, typedefs: false },
    ],
    // Single-line `if (x) return;` is the house style; multi-line bodies
    // still need braces.
    curly: ["error", "multi-line"],
    // `(await response.json()).field` is the idiomatic fetch read.
    "unicorn/no-await-expression-member": "off",
    // Positional groups in short regexes read fine.
    "eslint/prefer-named-capture-group": "off",
    // Chained ternaries are the house style for JSX variants.
    "eslint/no-nested-ternary": "off",
    "unicorn/no-nested-ternary": "off",
    // No useful threshold; splitting protocol handlers would scatter them.
    complexity: "off",
    // `onClick={() => void save()}` marks a deliberately floating promise.
    "eslint/no-void": "off",
    // Constructor parameter properties are the house style for classes.
    "typescript/parameter-properties": "off",
    // Handlers are named for what they do (onClick={archive}), not handleX.
    "react/jsx-handler-names": "off",
    // Object types are aliases: D1 and Durable Object SQL rows must be
    // assignable to Record<string, …>, which only aliases are implicitly.
    "typescript/consistent-type-definitions": ["error", "type"],
    // new Promise wraps callback and event APIs (timers, streams, sockets).
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    // Hono middleware's `await next()` is not a Node-style callback.
    "node/callback-return": "off",
    // Byte strings (base64, binary MIME parts) need UTF-16 code units, which
    // codePointAt would merge.
    "unicorn/prefer-code-point": "off",
    // slice() copies typed arrays and Array.from() accepts array-likes;
    // spreading would turn both into plain arrays.
    "unicorn/prefer-spread": "off",
    // Named imports from node:path read better than path.join everywhere.
    "unicorn/import-style": "off",
    // Errors are told apart with instanceof; setting `name` would change
    // what logs and error responses show.
    "unicorn/custom-error-definition": "off",
    // role="status"/"group" on a div keeps its layout and styling; <output>
    // and <fieldset> come with form semantics and default styles.
    "jsx-a11y/prefer-tag-over-role": "off",
    // Trailing comments label table-like data (CBOR keys, address forms).
    "eslint/no-inline-comments": "off",
    // Apostrophes and quotes render fine in JSX text (the rule has no option
    // to check only > and }).
    "react/no-unescaped-entities": "off",
    // `() => undefined` is the explicit no-op; the rule's fix turns it into
    // `() => {}`, which no-empty-function then rejects.
    "unicorn/no-useless-undefined": "off",
    // `{ omitted: _, ...rest }` is how the code drops fields from a copy.
    "eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    // Index reads (`const first = rows[0]`) read better than array patterns,
    // and destructuring into existing bindings needs awkward parentheses.
    "eslint/prefer-destructuring": [
      "error",
      {
        VariableDeclarator: { array: false, object: true },
        AssignmentExpression: { array: false, object: false },
      },
    ],
    // `() => {}` is the deliberate no-op callback or initial value.
    "eslint/no-empty-function": ["error", { allow: ["arrowFunctions"] }],
    // `x == null` is the deliberate null-or-undefined check.
    "eslint/eqeqeq": ["error", "always", { null: "ignore" }],
    "eslint/no-eq-null": "off",
    // toSorted()/toReversed() need Chrome 110, newer than Vite's default
    // build target, and aren't polyfilled; the calls sort fresh copies.
    "unicorn/no-array-sort": "off",
    "unicorn/no-array-reverse": "off",
    // Counters (`nextId++`, `index++`) read clearly in byte and ID loops.
    "eslint/no-plusplus": "off",
    // The Workers runtime types are a global .d.ts with no module to import.
    "typescript/triple-slash-reference": "off",
    // Bit operations are IP address math, CBOR and byte encoding, hashing.
    "eslint/no-bitwise": "off",
    // Helpers nested in the one function that uses them keep it
    // self-contained.
    "unicorn/consistent-function-scoping": "off",
    // Method signatures describe external objects (DOM, xmldom, KV), whose
    // methods are bivariant; property signatures would reject them.
    "typescript/method-signature-style": "off",
    // Labels wrap the shadcn controls too.
    "jsx-a11y/label-has-associated-control": [
      "error",
      {
        controlComponents: [
          "Input",
          "Select",
          "SelectTrigger",
          "Textarea",
          "Checkbox",
          "Radio",
          "RadioGroup",
          "Switch",
        ],
        depth: 3,
        labelComponents: ["Label"],
      },
    ],
    // Small error classes live with the module that throws them.
    "eslint/max-classes-per-file": "off",
    // Durable Object handlers and ProseMirror plugin methods must be instance
    // methods even when they don't use `this`.
    "eslint/class-methods-use-this": "off",
    // The cycles are between functions only (permissions ↔ modules, OIDC
    // service ↔ MCP clients) and resolve at call time.
    "import/no-cycle": "off",
    // Tiptap extensions export the same value as default and named.
    "import/no-named-as-default": "off",
    // `.then(onFulfilled, onRejected)` is deliberate: `.catch()` would also
    // catch errors thrown by the fulfilment handler.
    "promise/prefer-catch": "off",
    // `.then(() => { setState(…) })` needs no return value.
    "promise/always-return": "off",
    // forwardRef(function Name(…)) names the component for React DevTools.
    "eslint/prefer-arrow-callback": ["error", { allowNamedFunctions: true }],
    // Declaration order follows the algorithm (punycode).
    "eslint/sort-vars": "off",
    // `string & {}` keeps literal autocompletion on open string unions.
    "typescript/ban-types": "off",
    // `catch (failure)` keeps clear of an `error` state or variable in scope.
    "unicorn/catch-error-name": "off",
    // Flags Effect's Output.map(x, fn), ProseMirror's mapping.map(pos, 1) and
    // PDF.js's find(query, again), which aren't array methods.
    "unicorn/no-array-method-this-argument": "off",
    // forEach on ProseMirror fragments and listener sets, which aren't arrays.
    "unicorn/no-array-for-each": "off",
    // TypeError would change what callers and logs see.
    "unicorn/prefer-type-error": "off",
    // `typeof import("./x")` in type positions, for lazily imported modules.
    "typescript/consistent-type-imports": [
      "error",
      { disallowTypeAnnotations: false },
    ],
    // email's browser code is typechecked with the Workers types, whose
    // Element.append() is HTMLRewriter's; appendChild() keeps the DOM types.
    "unicorn/prefer-dom-node-append": "off",
    // `value ?? fallback` also covers null, which a default parameter doesn't.
    "unicorn/prefer-default-parameters": "off",
    // Re-exported names are also used in the module itself.
    "unicorn/prefer-export-from": "off",
    // if/else blocks with statements read better than a ternary here.
    "unicorn/prefer-ternary": "off",
    // Effect.gen(function* () { … }) is Effect's idiom (Effect.fn("name")
    // when a span is wanted), so generators stay anonymous.
    "func-names": ["error", "always", { generators: "never" }],
  },
  overrides: [
    {
      // The global Env is extended by declaration merging, one module at a
      // time, which only an (often empty) interface can do.
      files: ["**/bindings.d.ts"],
      rules: {
        "typescript/consistent-type-definitions": "off",
        "typescript/no-empty-interface": "off",
        "typescript/no-empty-object-type": "off",
      },
    },
    {
      // shadcn/ui primitives, generated by its CLI: the label is wired up by
      // whoever uses it.
      files: ["packages/core/src/components/ui/**"],
      rules: {
        "jsx-a11y/label-has-associated-control": "off",
        "jsx-a11y/click-events-have-key-events": "off",
        "jsx-a11y/no-noninteractive-element-interactions": "off",
        // querySelectorAll() yields Elements, which have no dataset.
        "unicorn/prefer-dom-node-dataset": "off",
      },
    },
    {
      // Alchemy resources pair a type and a value of the same name.
      files: ["packages/*/alchemy/**"],
      rules: { "eslint/no-redeclare": "off" },
    },
    {
      files: effectFiles,
      rules: {
        "anti-slop-effect/no-manual-effect-error-tag": "error",
        "anti-slop-effect/no-manual-tag-comparison": "error",
        "anti-slop-effect/no-manual-tagged-construction": "error",
        "anti-slop-effect/no-service-constructor-imports": "error",
        "anti-slop-effect/prefer-effect-match": "error",
      },
    },
    {
      files: testFiles,
      rules: {
        // useFreshWorkspace() and friends are test helpers, not React hooks.
        "react-hooks/rules-of-hooks": "off",
        // Stubbed platform objects have no-op methods.
        "eslint/no-empty-function": "off",
      },
    },
  ],
});
