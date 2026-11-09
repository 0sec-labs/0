module.exports = input => {
  const catalog = {};
  catalog.normal = {};
  const entry = (Object.hasOwn(catalog, input.name) ? catalog[input.name] : undefined);
  if (entry) Object.assign(entry, input.values);
  return catalog.normal;
};
