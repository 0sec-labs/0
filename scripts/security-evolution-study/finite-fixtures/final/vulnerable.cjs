module.exports = input => {
  const catalog = {};
  catalog.normal = {};
  const entry = catalog[input.name];
  if (entry) Object.assign(entry, input.values);
  return catalog.normal;
};
