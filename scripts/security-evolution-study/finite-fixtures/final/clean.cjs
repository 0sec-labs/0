module.exports = input => {
  const catalog = new Map([['normal', {}]]);
  if (catalog.has(input.name)) catalog.set(input.name, Object.fromEntries(Object.entries(input.values)));
  return catalog.get('normal');
};
