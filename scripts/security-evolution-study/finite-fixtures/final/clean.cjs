module.exports = input => {
  const catalog = Object.create(null);
  catalog.normal = {};
  const entry = (Object.hasOwn(catalog, input.name) ? catalog[input.name] : undefined);
  if (entry) Object.assign(entry, input.values);
  return catalog.normal;
};
