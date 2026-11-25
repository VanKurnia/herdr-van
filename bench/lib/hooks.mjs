// Points the bare specifiers a mod imports at the bench's stubs.
// Registered as an asynchronous loader, which accepts `next()` for everything else.

const stubs = { herdr: "herdr.mjs", "gpui-kit": "gpui-kit.mjs", "gpui-base": "gpui-base.mjs" };

export async function resolve(specifier, context, next) {
  const stub = stubs[specifier];
  if (stub) return { url: new URL(`./stubs/${stub}`, import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
