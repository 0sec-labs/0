module.exports = input => {
  const catalog = { normal: {} };
  const entry = Object.hasOwn(catalog, input.name) ? catalog[input.name] : undefined;
  if (entry) {
    for (const [key, value] of Object.entries(input.values)) {
      Object.defineProperty(entry, key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
  return catalog.normal;
};
